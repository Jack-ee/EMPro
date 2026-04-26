// ============================================================
// sync.js — Learning data sync via GitHub Gist
//
// Design goals:
//   • Profile-scoped: each PROFILE_ID has its own Gist file, so
//     multiple users on the same Gist don't clobber each other.
//   • Bidirectional: pulls on load, on focus, and every 30s while
//     visible, so PC ↔ phone stay in sync without manual action.
//   • Whole-document last-write-wins, scoped to the current
//     profile's keys (plus the shared API key). The conflict
//     window is shrunk by aggressive pulls before edits — the
//     focus / visibility / 30s-poll triggers mean a device
//     usually has the latest remote state before the user starts
//     typing. There is still a window where two devices can edit
//     before either pulls; in that case the device that pushes
//     last wins for the keys it touched. A future revision can
//     add per-key timestamps for true key-level merging.
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

    // Listen-mode check: when the user is auto-playing sentences, a
    // background pull that reloads the page would yank them out of
    // flow. Manual Push/Pull from Settings bypasses this — that's the
    // user's explicit request, we honor it immediately.
    //
    // We probe SentenceDrill's state via a getter rather than reaching
    // into module internals. If SentenceDrill isn't loaded yet or
    // doesn't expose the getter, we treat it as "not active" (safe default).
    // Returns true if ANY active playback session is running — either
    // sentence listen mode OR My Words autoplay. Sync pulls/pushes are
    // suppressed during playback so network traffic and page reloads
    // from a .setGistId/pull don't interrupt TTS.
    function isListenActive() {
        try {
            if (window.SentenceDrill?.isListenActive?.()) return true;
            if (window.MyWords?.isAutoplayActive?.())     return true;
            return false;
        } catch {
            return false;
        }
    }

    async function init() {
        if (initialized) return;
        initialized = true;
        migrateLegacyToken();
        fixPoisonedSyncTime();
        hookSaves();
        if (getToken() && getGistId()) {
            await pull(false);  // silent initial pull
        }
        updateSyncUI();
        startPolling();
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibilityChange);
    }

    // One-time migration: earlier versions of sync.js incorrectly advanced
    // `lastPull` to Date.now() on no-op pulls, which could push it far
    // beyond any legitimate Gist timestamp and block all future pulls.
    // Zero it out once so the first pull after this upgrade always applies.
    function fixPoisonedSyncTime() {
        const FIX_FLAG = 'emp_sync_v2_fix_applied';
        if (localStorage.getItem(FIX_FLAG)) return;
        localStorage.removeItem(K_LAST_PULL);
        localStorage.removeItem(K_LAST_PUSH);
        localStorage.setItem(FIX_FLAG, '1');
        console.log('[Sync] Applied v2 timestamp fix');
    }

    function onFocus() {
        if (isListenActive()) return;
        if (getToken() && getGistId()) pull(false);
    }

    function onVisibilityChange() {
        if (isListenActive()) return;
        if (!document.hidden && getToken() && getGistId()) pull(false);
    }

    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
            if (isListenActive()) return;
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
    //   • Local keys that are NOT in the remote payload are removed,
    //     so deletions on another device propagate to this one.
    //   • Skips if remote profile doesn't match (safety net).
    //   • Caveat: if this device has unsynced local-only additions
    //     (e.g. words added while offline) and a newer remote pull
    //     arrives, those local-only additions WILL be removed. In
    //     practice this is rare because triggerSave() debounces
    //     pushes within a few seconds of the edit.
    //
    // Returns:
    //   { applied: false }                                — profile mismatch / bad payload
    //   { applied: true, changed, configChanged, dataChangeCount } — applied
    //
    //   • changed:           any tracked key differs from local (data or config).
    //   • configChanged:     a key that needs a page reload to take effect
    //                        was modified. Currently this is only `emp_api_key`
    //                        because the AI engine reads it once at boot.
    //                        All other keys (notebook, prefs, history) take
    //                        effect on the next render and don't need a reload.
    //   • dataChangeCount:   how many data keys (notebook, history, etc.)
    //                        differ from local; used for the toast message.
    function mergeSyncData(payload) {
        if (!payload || !payload.data) return { applied: false };
        if (payload._profile && payload._profile !== profileId()) {
            console.warn('[Sync] Profile mismatch — remote:', payload._profile, 'local:', profileId());
            return { applied: false };
        }
        suspendHooks = true;
        try {
            const remote = payload.data;
            const prefix = keyPrefix();

            // Snapshot current local state for the same set of keys we'll
            // touch, so we can detect "nothing actually changed".
            const localBefore = {};
            const localKeys   = new Set();
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && (k.startsWith(prefix) || k === 'emp_api_key')) {
                    localKeys.add(k);
                    localBefore[k] = localStorage.getItem(k);
                }
            }

            let changed          = false;
            let configChanged    = false;
            let dataChangeCount  = 0;

            // Keys that REQUIRE a page reload to take effect. Anything not
            // in this set takes effect on the next render of the relevant
            // module — no reload needed, no UX disruption.
            const requiresReload = (k) => k === 'emp_api_key';

            // Write remote keys, tracking real changes
            Object.keys(remote).forEach(k => {
                if (k.startsWith(prefix) || k === 'emp_api_key') {
                    if (localBefore[k] !== remote[k]) {
                        changed = true;
                        if (requiresReload(k)) configChanged = true;
                        else                   dataChangeCount++;
                    }
                    localStorage.setItem(k, remote[k]);
                    localKeys.delete(k);
                }
            });

            // Remove local keys that no longer exist in remote
            // (so deletions on another device propagate correctly)
            if (localKeys.size > 0) {
                changed = true;
                localKeys.forEach(k => {
                    if (requiresReload(k)) configChanged = true;
                    else                   dataChangeCount++;
                    localStorage.removeItem(k);
                });
            }

            setLastPull(payload._syncTime || Date.now());
            return { applied: true, changed, configChanged, dataChangeCount };
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
        updateSyncUI();
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

            // Manual pulls (showToast=true) always apply remote if it has
            // a newer or equal _syncTime. Background polls use the strict
            // "strictly newer than last pull" check to avoid reload loops.
            const shouldApply = showToast
                ? (remoteTime >= lastPull)
                : (remoteTime > lastPull);

            if (shouldApply && remoteTime > 0) {
                const result = mergeSyncData(payload) || {};

                // If the merge applied but no actual content changed (e.g. we
                // just pulled back our own push, or another tab pushed the
                // identical state), there is nothing to refresh — skip the
                // reload entirely. This is the main fix for the "PC reloads
                // every ~30s while I'm typing" complaint.
                if (!result.changed) {
                    if (showToast) window.App?.showToast?.('Already up to date.');
                    else           console.log('[Sync] Pulled — no content change, skipping reload');
                    updateSyncUI();
                    return true;
                }

                // Real change. New policy (v=67):
                //   • Only reload if a CONFIG key changed (currently just
                //     emp_api_key — the AI engine reads it once at boot).
                //   • Data changes (notebook, history, progress) apply
                //     silently. Modules that need to re-render to show
                //     fresh data listen for the 'emp:datachanged' event
                //     dispatched below.
                //   • A small toast tells the user something arrived.
                // This means: editing on phone → opening laptop won't
                // jerk the user out of whatever tab they're on. The data
                // is updated under the hood; next time the user navigates
                // to that module (or it re-renders), they see fresh data.
                if (!result.configChanged) {
                    const n = result.dataChangeCount || 0;
                    if (showToast) {
                        window.App?.showToast?.(n > 0
                            ? `Synced ${n} change${n === 1 ? '' : 's'} from cloud.`
                            : 'Synced from cloud.');
                    } else {
                        console.log(`[Sync] Pulled ${n} data change(s) — applied silently, no reload`);
                    }

                    // Notify live modules so they can refresh their views
                    // without a page reload. Each module decides whether
                    // to act on this (e.g. MyWords re-renders, Drill ignores).
                    try {
                        window.dispatchEvent(new CustomEvent('emp:datachanged', {
                            detail: { source: 'sync-pull', count: n }
                        }));
                    } catch {}

                    updateSyncUI();
                    return true;
                }

                // Config change → reload required (e.g. API key was rotated).
                // Defer the reload while the user is mid-session (typing in
                // writing-lab, drilling, autoplay) to avoid disruption.
                const doReload = () => {
                    const busy = (() => {
                        try { return Boolean(window.App?.isStudySessionActive?.()); }
                        catch { return false; }
                    })();
                    if (busy && !showToast) {
                        // Background pull found a config change but the user
                        // is mid-flow. Retry shortly. Manual pulls (showToast)
                        // bypass this — the user explicitly asked.
                        console.log('[Sync] Config change pulled, but study session active — deferring reload');
                        setTimeout(doReload, 30000);
                        return;
                    }
                    location.reload();
                };

                if (showToast) window.App?.showToast?.('Configuration changed. Reloading...');
                else           console.log('[Sync] Pulled config change from Gist');
                setTimeout(doReload, showToast ? 600 : 300);
                return true;
            } else {
                if (showToast) window.App?.showToast?.('Already up to date.');
                // IMPORTANT: do NOT advance lastPull here. The whole point of
                // lastPull is "the newest remote timestamp we've applied" — if
                // we update it on no-op pulls, future legitimate pulls (where
                // a different device pushed at a timestamp between our last
                // applied pull and now) get rejected.
                updateSyncUI();
                return true;
            }
        } catch (e) {
            console.log('[Sync] Pull error:', e.message || e);
            if (showToast) window.App?.showToast?.('Pull failed — check token/network.');
            return false;
        } finally {
            isSyncing = false;
            updateSyncUI();
        }
    }

    async function push(showToast) {
        if (!getToken() || isSyncing) {
            if (showToast) window.App?.showToast?.('Set GitHub token in Settings first.');
            return false;
        }
        isSyncing = true;
        updateSyncUI();
        if (showToast) window.App?.showToast?.('Syncing to cloud...');
        try {
            // Capture the payload's _syncTime BEFORE the network call so we
            // can advance lastPull in lockstep on success. This is the fix
            // for the "PC reloads ~30s after every edit" loop:
            //   without this, push set lastPush but left lastPull stale, so
            //   the next 30s poll always saw remote._syncTime > lastPull
            //   (because remote == our own push) and reloaded the page.
            //   With this, the next poll sees remoteTime == lastPull and
            //   skips. Other devices' pushes still trigger pulls correctly.
            const data = collectSyncData();
            const ok   = await writeGist(data);
            if (ok) setLastPull(data._syncTime);
            if (showToast) window.App?.showToast?.(ok ? 'Synced to cloud.' : 'Sync failed — check token.');
            return ok;
        } finally {
            isSyncing = false;
            updateSyncUI();
        }
    }

    // First-time setup: after a token is saved, look for an existing Gist
    // that matches our profile's sync file. If found, pull it (don't
    // overwrite). If not found, push to create one.
    // This prevents the footgun where a fresh device with empty data
    // would clobber an existing Gist on first save.
    async function setupSync() {
        if (!getToken()) return false;
        isSyncing = true;
        updateSyncUI();
        try {
            // If we already have a gist ID (legacy setup), just pull
            if (getGistId()) {
                window.App?.showToast?.('Syncing from cloud...');
                const payload = await readGist().catch(() => null);
                if (payload && payload._syncTime) {
                    mergeSyncData(payload);
                    window.App?.showToast?.('Synced from cloud. Reloading...');
                    setTimeout(() => location.reload(), 600);
                    return true;
                }
                // Gist exists but is empty — push current state
                await writeGist(collectSyncData());
                window.App?.showToast?.('Synced to cloud.');
                return true;
            }

            // No gist ID — search user's gists for one matching our sync filename
            window.App?.showToast?.('Looking for existing sync...');
            const resp = await fetch(`${GIST_API}?per_page=100`, {
                headers: { 'Authorization': `Bearer ${getToken()}`, 'Accept': 'application/vnd.github+json' }
            });
            if (!resp.ok) throw new Error(`Gist list failed: ${resp.status}`);
            const list = await resp.json();
            const target = gistFile();
            const matches = (list || []).filter(g => g.files && g.files[target]);

            // Sort newest-first by updated_at — handles the edge case where
            // past bugs created multiple sync Gists on the same account.
            matches.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
            const match = matches[0];

            if (matches.length > 1) {
                console.warn(`[Sync] Found ${matches.length} sync Gists — picked newest (${match.id}). Older duplicates:`,
                    matches.slice(1).map(g => `${g.id} (${g.updated_at})`));
            }

            if (match) {
                // Found an existing Gist — adopt and pull
                setGistId(match.id);
                console.log('[Sync] Found existing Gist:', match.id);
                window.App?.showToast?.('Found existing sync. Pulling...');
                const payload = await readGist();
                if (payload && payload._syncTime) {
                    mergeSyncData(payload);
                    window.App?.showToast?.('Synced from cloud. Reloading...');
                    setTimeout(() => location.reload(), 600);
                    return true;
                }
                window.App?.showToast?.('Gist was empty. Pushed local data.');
                await writeGist(collectSyncData());
                return true;
            }

            // No existing Gist — create one via push
            window.App?.showToast?.('Creating new sync Gist...');
            const ok = await writeGist(collectSyncData());
            window.App?.showToast?.(ok ? 'Synced to cloud. Future devices will merge here.' : 'Setup failed — check token.');
            return ok;
        } catch (e) {
            console.warn('[Sync] setupSync error:', e.message || e);
            window.App?.showToast?.('Sync setup failed. Check token + network.');
            return false;
        } finally {
            isSyncing = false;
            updateSyncUI();
        }
    }

    function triggerSave() {
        if (suspendHooks || !getToken()) return;
        if (saveTimer) clearTimeout(saveTimer);
        // Defer the push while playback is active. Any data changes made
        // during playback (e.g. tracking progress on played sentences) will
        // still land in localStorage immediately; the Gist push just waits
        // until playback ends, at which point the next triggerSave (or the
        // 30s poll / focus pull) picks them up.
        saveTimer = setTimeout(() => {
            if (isListenActive()) {
                // Retry shortly; keeps debouncer behavior without losing the save.
                saveTimer = setTimeout(() => { if (!isListenActive()) push(false); }, 5000);
                return;
            }
            push(false);
        }, DEBOUNCE_MS);
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
            hr.insertBefore(el, hr.firstChild);
            el.addEventListener('click', handleSyncClick);
        }
        el.classList.toggle('syncing', isSyncing);
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
        setupSync,      // first-time setup: find existing Gist or create new
        updateSyncUI,
        setToken,       // for settings UI
        getToken        // for settings UI
    };
})();
