// ============================================================
// sync.js — Auto-sync learning data via GitHub Gist
//
// Stores all learning progress in a private GitHub Gist.
// Works from any device: GitHub Pages, localhost, or file://
// ============================================================

window.SyncManager = (function() {

    const GIST_FILE    = 'emp-sync.json';
    const DEBOUNCE_MS  = 3000;
    const GIST_API     = 'https://api.github.com/gists';
    let saveTimer      = null;
    let lastSyncTime   = 0;
    let initialized    = false;
    let isSyncing      = false;

    function getToken()  { return window.DB?.getPref?.('sync_github_token', '') || ''; }
    function getGistId() { return window.DB?.getPref?.('sync_gist_id', '')     || ''; }
    function setGistId(id) { window.DB?.setPref?.('sync_gist_id', id); }

    async function init() {
        if (initialized) return;
        initialized = true;
        hookSaves();
        if (getToken() && getGistId()) {
            await autoLoad();
        }
        updateSyncUI();
    }

    async function autoLoad() {
        if (!getToken() || !getGistId()) return;
        try {
            const data = await readGist();
            if (!data) return;
            const fileTime  = data._syncTime || 0;
            const localTime = parseInt(window.DB?.getPref?.('_syncTime', '0') || '0');
            if (fileTime > localTime) {
                mergeSyncData(data);
                console.log('[Sync] Loaded newer data from Gist');
                setTimeout(() => location.reload(), 500);
            } else {
                console.log('[Sync] Local data is current');
            }
        } catch (e) {
            console.log('[Sync] Auto-load skipped:', e.message || e);
        }
    }

    async function readGist() {
        const token = getToken(), gistId = getGistId();
        if (!token || !gistId) return null;
        const resp = await fetch(`${GIST_API}/${gistId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!resp.ok) { if (resp.status === 404) setGistId(''); return null; }
        const gist = await resp.json();
        const file = gist.files?.[GIST_FILE];
        if (!file?.content) return null;
        return JSON.parse(file.content);
    }

    async function writeGist(data) {
        const token = getToken();
        if (!token) return false;
        const json = JSON.stringify(data, null, 2);
        let gistId = getGistId();
        try {
            if (gistId) {
                const resp = await fetch(`${GIST_API}/${gistId}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ files: { [GIST_FILE]: { content: json } } })
                });
                if (!resp.ok) throw new Error(`Gist update failed: ${resp.status}`);
            } else {
                const resp = await fetch(GIST_API, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        description: 'English Master Pro — learning data',
                        public: false,
                        files: { [GIST_FILE]: { content: json } }
                    })
                });
                if (!resp.ok) throw new Error(`Gist create failed: ${resp.status}`);
                const gist = await resp.json();
                setGistId(gist.id);
                console.log('[Sync] Created new Gist:', gist.id);
            }
            lastSyncTime = Date.now();
            updateSyncUI();
            return true;
        } catch (e) {
            console.warn('[Sync] Write failed:', e);
            return false;
        }
    }

    function mergeSyncData(data) {
        const prefix = 'emp_';
        Object.keys(data).forEach(k => {
            if (k.startsWith(prefix)) localStorage.setItem(k, data[k]);
        });
        window.DB?.setPref?.('_syncTime', String(data._syncTime || Date.now()));
    }

    function collectSyncData() {
        const prefix = 'emp_', data = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(prefix)) data[k] = localStorage.getItem(k);
        }
        data._syncTime = Date.now();
        window.DB?.setPref?.('_syncTime', String(data._syncTime));
        return data;
    }

    function triggerSave() {
        if (!getToken() || isSyncing) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            isSyncing = true;
            await writeGist(collectSyncData());
            isSyncing = false;
        }, DEBOUNCE_MS);
    }

    function hookSaves() {
        if (!window.DB) return;
        // Only hook methods that change real learning data
        // NOT setPref — it fires on saveDraft, speed changes, etc.
        ['saveNotebook', 'saveStats', 'saveWritingEntry',
         'deleteWritingEntry', 'upsertNotebookWord', 'removeNotebookWord', 'toggleFocus'
        ].forEach(method => {
            const orig = window.DB[method];
            if (typeof orig === 'function') {
                window.DB[method] = function(...args) {
                    const result = orig.apply(this, args);
                    triggerSave();
                    return result;
                };
            }
        });
    }

    function updateSyncUI() {
        let el = document.getElementById('sync-indicator');
        if (!el) {
            const hr = document.querySelector('.header-right');
            if (!hr) return;
            el = document.createElement('button');
            el.id = 'sync-indicator'; el.className = 'header-btn';
            el.style.cssText = 'font-size:14px;padding:4px;';
            hr.insertBefore(el, hr.firstChild);
            el.addEventListener('click', handleSyncClick);
        }
        const hasToken = Boolean(getToken()), hasGist = Boolean(getGistId());
        if (hasToken && hasGist) {
            el.textContent = '\u2601\uFE0F';
            el.title = lastSyncTime ? `Synced: ${new Date(lastSyncTime).toLocaleTimeString()}` : 'Cloud sync active';
        } else if (hasToken) {
            el.textContent = '\u2601\uFE0F';
            el.title = 'First save will create your sync Gist';
        } else {
            el.textContent = '\u26A1';
            el.title = 'Set GitHub token in Settings to enable cloud sync';
        }
    }

    async function handleSyncClick() {
        if (!getToken()) {
            window.App?.showToast?.('Set your GitHub token in Settings first.');
            window.App?.openSettings?.();
            return;
        }
        window.App?.showToast?.('Syncing...');
        const ok = await writeGist(collectSyncData());
        window.App?.showToast?.(ok ? 'Synced to cloud.' : 'Sync failed \u2014 check token.');
    }

    return { init, triggerSave };
})();
