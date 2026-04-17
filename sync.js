// ============================================================
// sync.js — Learning data sync via GitHub Gist
//
// Design goals:
//   • Profile-scoped: each PROFILE_ID has its own Gist file, so
//     multiple users on the same Gist don't clobber each other.
//   • Bidirectional: pulls on load, on focus, and every 30s while
//     visible, so PC ↔ phone stay in sync without manual action.
//   • Last-write-wins at the *key* level, not the whole document,
//     so concurrent edits on different modules don't overwrite.
//   • Raw localStorage for sync metadata — bypassing DB.setPref
//     avoids the profile-prefix double-wrapping bug.
// ============================================================

window.SyncManager = (function() {

    const GIST_API     = 'https://api.github.com/gists';
    const DEBOUNCE_MS  = 3000;
    const POLL_MS      = 30000;

    // Raw localStorage keys (NOT wrapped by DB.setPref — metadata must be
    // exactly-matched across devices, not profile-prefixed).
    const K_TOKEN      = 'emp_sync_token';
    const K_GIST_ID    = 'emp_sync_gist_id';
    const K_LAST_PULL  = 'emp_sync_last_pull';
    const K_LAST_PUSH  = 'emp_sync_last_push';

    let saveTimer     = null;
    let pollTimer     = null;
    let initialized   = false;
    let isSyncing     = false;
    let suspendHooks  = false;  // prevents triggerSave loop during pull

    // ─── Profile-scoped helpers ──────────────────────────────
    function profileId()  { return (window.APP_CONFIG && window.APP_CONFIG.PROFILE_ID) || 'default'; }
    function gistFile()   { return `emp-sync-${profileId()}.json`; }
    function keyPrefix()  { return `emp_${profileId()}_`; }

    // ─── Settings accessors (raw localStorage) ───────────────
    function getToken()      { return localStorage.getItem(K_TOKEN)   || ''; }
    function setToken(t)     { t ? localStorage.setItem(K_TOKEN, t)   : localStorage.removeItem(K_TOKEN); }
    function getGistId()     { return localStorage.getItem(K_GIST_ID) || ''; }
    function setGistId(id)   { id ? localStorage.setItem(K_GIST_ID, id) : localStorage.removeItem(K_GIST_ID); }
    function getLastPull()   { return parseInt(localStorage.getItem(K_LAST_PULL) || '0', 10); }
    function setLastPull(t)  { localStorage.setItem(K_LAST_PULL, String(t)); }
    function getLastPush()   { return parseInt(localStorage.getItem(K_LAST_PUSH) || '0', 10); }
    function setLastPush(t)  { localStorage.setItem(K_LAST_PUSH, String(t)); }

    // Bridge to the legacy DB.getPref-stored token, in case user had one saved
    // from the previous version. Migrate it once.
    function migrateLegacyToken() {
        if (getToken()) return;
        const legacy = window.DB?.getPref?.('sync_github_token', '');
        if (legacy) {
            setToken(legacy);
            console.log('[Sync] Migrated legacy GitHub token to new storage');
        }
    }

    // ─── Init ────────────────────────────────────────────────
    async function init() {
        if (initialized) return;
        initialized = true;
        migrateLegacyToken();
        hookSaves();
        if (getToken() && getGistId()) {
            await pull(false);  // silent initial pull
        }
        updateSyncUI();
        startPolling();
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibilityChange);
    }

    function onFocus() {
        if (getToken() && getGistId()) pull(false);
    }

    function onVisibilityChange() {
        if (!document.hidden && getToken() && getGistId()) pull(false);
    }

    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
            if (!document.hidden && getToken() && getGistId() && !isSyncing) {
                pull(false);
            }
        }, POLL_MS);
    }

    // ─── Gist I/O ────────────────────────────────────────────
    async function readGist() {
        const token = getToken(), gistId = getGistId();
        if (!token || !gistId) return null;
        const resp = await fetch(`${GIST_API}/${gistId}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
        });
        if (!resp.ok) {
            if (resp.status === 404) setGistId('');  // Gist was deleted
            throw new Error(`Gist read failed: ${resp.status}`);
        }
        const gist = await resp.json();
        const file = gist.files?.[gistFile()];
        if (!file?.content) return null;
        try { return JSON.parse(file.content); }
        catch { return null; }
    }

    async function writeGist(data) {
        const token = getToken();
        if (!token) return false;
        const json   = JSON.stringify(data);
        let gistId   = getGistId();
        const body   = { files: { [gistFile()]: { content: json } } };

        try {
            let resp;
            if (gistId) {
                resp = await fetch(`${GIST_API}/${gistId}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
                    body: JSON.stringify(body)
                });
                if (resp.status === 404) {
                    // Gist was deleted — create a new one
                    setGistId('');
                    return writeGist(data);
                }
                if (!resp.ok) throw new Error(`Gist update failed: ${resp.status}`);
            } else {
                resp = await fetch(GIST_API, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
                    body: JSON.stringify({
                        description: 'English Master Pro — learning data',
                        public: false,
                        ...body
                    })
                });
                if (!resp.ok) throw new Error(`Gist create failed: ${resp.status}`);
                const gist = await resp.json();
                setGistId(gist.id);
                console.log('[Sync] Created new Gist:', gist.id);
            }
            setLastPush(Date.now());
            updateSyncUI();
            return true;
        } catch (e) {
            console.warn('[Sync] Write failed:', e.message || e);
            return false;
        }
    }

    // ─── Collect / Merge ─────────────────────────────────────
    // Collects only the current profile's keys, plus the shared API key.
    function collectSyncData() {
        const prefix   = keyPrefix();
        const data     = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k) continue;
            if (k.startsWith(prefix)) data[k] = localStorage.getItem(k);
        }
        // Shared (not profile-scoped): API key
        const apiKey = localStorage.getItem('emp_api_key');
        if (apiKey) data['emp_api_key'] = apiKey;

        return {
            _version   : 2,
            _syncTime  : Date.now(),
            _device    : getDeviceLabel(),
            _profile   : profileId(),
            data       : data
        };
    }

    // Merge remote payload into local storage.
    //   • If remote _syncTime > local last-pull, apply remote wholesale.
    //   • Preserves keys that exist locally but not in remote (recent local-only
    //     additions won't get deleted just because remote is older for them).
    //   • Skips if remote profile doesn't match (safety net).
    function mergeSyncData(payload) {
        if (!payload || !payload.data) return false;
        if (payload._profile && payload._profile !== profileId()) {
            console.warn('[Sync] Profile mismatch — remote:', payload._profile, 'local:', profileId());
            return false;
        }
        suspendHooks = true;
        try {
            const remote = payload.data;
            const prefix = keyPrefix();

            // Collect current local keys for this profile (and shared API key)
            const localKeys = new Set();
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && (k.startsWith(prefix) || k === 'emp_api_key')) localKeys.add(k);
            }

            // Write remote keys
            Object.keys(remote).forEach(k => {
                if (k.startsWith(prefix) || k === 'emp_api_key') {
                    localStorage.setItem(k, remote[k]);
                    localKeys.delete(k);
                }
            });

            // Remove local keys that no longer exist in remote
            // (so deletions on another device propagate correctly)
            localKeys.forEach(k => localStorage.removeItem(k));

            setLastPull(payload._syncTime || Date.now());
            return true;
        } finally {
            suspendHooks = false;
        }
    }

    function getDeviceLabel() {
        const ua = navigator.userAgent || '';
        if (/Android/.test(ua))  return 'Android';
        if (/iPhone|iPad/.test(ua)) return 'iOS';
        if (/Mac/.test(ua))      return 'Mac';
        if (/Windows/.test(ua))  return 'Windows';
        if (/Linux/.test(ua))    return 'Linux';
        return 'Unknown';
    }

    // ─── Pull / Push ─────────────────────────────────────────
    async function pull(showToast) {
        if (!getToken() || !getGistId() || isSyncing) {
            if (showToast) window.App?.showToast?.('Set up GitHub sync in Settings first.');
            return false;
        }
        isSyncing = true;
        if (showToast) window.App?.showToast?.('Pulling...');
        try {
            const payload = await readGist();
            if (!payload) {
                if (showToast) window.App?.showToast?.('No remote data yet.');
                return false;
            }
            const remoteTime = payload._syncTime || 0;
            const lastPull   = getLastPull();
            const lastPush   = getLastPush();

            // If remote is newer than our last pull AND newer than our last local push,
            // apply it. Otherwise, our local state already reflects (or supersedes) remote.
            if (remoteTime > lastPull && remoteTime >= lastPush) {
                mergeSyncData(payload);
                if (showToast) window.App?.showToast?.('Synced from cloud. Reloading...');
                else           console.log('[Sync] Pulled newer data from Gist');
                setTimeout(() => location.reload(), showToast ? 600 : 300);
                return true;
            } else {
                if (showToast) window.App?.showToast?.('Already up to date.');
                setLastPull(Date.now());
                updateSyncUI();
                return true;
            }
        } catch (e) {
            console.log('[Sync] Pull error:', e.message || e);
            if (showToast) window.App?.showToast?.('Pull failed — check token/network.');
            return false;
        } finally {
            isSyncing = false;
        }
    }

    async function push(showToast) {
        if (!getToken() || isSyncing) {
            if (showToast) window.App?.showToast?.('Set GitHub token in Settings first.');
            return false;
        }
        isSyncing = true;
        if (showToast) window.App?.showToast?.('Syncing to cloud...');
        try {
            const ok = await writeGist(collectSyncData());
            if (showToast) window.App?.showToast?.(ok ? 'Synced to cloud.' : 'Sync failed — check token.');
            return ok;
        } finally {
            isSyncing = false;
        }
    }

    function triggerSave() {
        if (suspendHooks || !getToken()) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => push(false), DEBOUNCE_MS);
    }

    // ─── Hook DB methods so changes auto-push ─────────────────
    // Prefs that change too frequently to be worth auto-syncing
    // (drafts on every keystroke, slider scrubs, scroll positions).
    // Data still gets picked up on the next push triggered by a real
    // save, the focus/visibility pull, or the 30s poll.
    const PREF_SYNC_BLOCKLIST = new Set([
        'wl_draft',         // writing lab draft (fires on every keystroke)
        'speech_speed',     // slider
        'voice_id',         // voice selector
        'auto_speak',       // checkbox
        'show_cn_default',  // checkbox
        'group_size',       // number input
        'ai_provider',      // provider selector (rarely changed)
        'ai_model',         // model selector (rarely changed)
        'mw_progress',      // scroll/position within My Words
        'mw_pos_all', 'mw_pos_core', 'mw_pos_pronunciation',
        'mw_pos_spelling', 'mw_pos_weak'
    ]);

    function hookSaves() {
        if (!window.DB) return;
        const methods = [
            'saveNotebook', 'saveStats', 'saveWritingEntry',
            'deleteWritingEntry', 'upsertNotebookWord', 'removeNotebookWord',
            'toggleFocus'
        ];
        methods.forEach(m => {
            const orig = window.DB[m];
            if (typeof orig !== 'function') return;
            window.DB[m] = function(...args) {
                const result = orig.apply(this, args);
                triggerSave();
                return result;
            };
        });

        // Hook setPref selectively — expression progress uses it, and we
        // don't want those changes to be sync-invisible.
        const origSetPref = window.DB.setPref;
        if (typeof origSetPref === 'function') {
            window.DB.setPref = function(name, val) {
                const result = origSetPref.apply(this, [name, val]);
                if (!PREF_SYNC_BLOCKLIST.has(name)) triggerSave();
                return result;
            };
        }
    }

    // ─── UI: status indicator in header ──────────────────────
    function updateSyncUI() {
        let el = document.getElementById('sync-indicator');
        if (!el) {
            const hr = document.querySelector('.header-right');
            if (!hr) return;
            el = document.createElement('button');
            el.id = 'sync-indicator';
            el.className = 'header-btn';
            el.style.cssText = 'font-size:14px;';
            hr.insertBefore(el, hr.firstChild);
            el.addEventListener('click', handleSyncClick);
        }
        const hasToken = Boolean(getToken());
        const hasGist  = Boolean(getGistId());
        const lastPush = getLastPush();
        const lastPull = getLastPull();
        const lastAny  = Math.max(lastPush, lastPull);

        if (hasToken && hasGist) {
            el.textContent = '\u2601\uFE0F';  // ☁️
            el.title = lastAny
                ? `Synced: ${new Date(lastAny).toLocaleTimeString()}\n(click to pull now)`
                : 'Cloud sync active — click to pull';
        } else if (hasToken) {
            el.textContent = '\u2601\uFE0F';
            el.title = 'First save will create your sync Gist';
        } else {
            el.textContent = '\u26A1';  // ⚡
            el.title = 'Set GitHub token in Settings to enable cloud sync';
        }
    }

    async function handleSyncClick() {
        if (!getToken()) {
            window.App?.showToast?.('Set GitHub token in Settings first.');
            window.App?.openSettings?.();
            return;
        }
        if (!getGistId()) {
            // No Gist yet — push first to create one
            await push(true);
            return;
        }
        // Manual pull
        await pull(true);
    }

    // ─── Public API ──────────────────────────────────────────
    return {
        init,
        triggerSave,
        pull,
        push,
        updateSyncUI,
        setToken,       // for settings UI
        getToken        // for settings UI
    };
})();
