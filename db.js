// ============================================================
// db.js — English Master Pro Data Layer
// ============================================================

(function() {
    const PREFIX = 'emp_';

    function key(name) {
        const pid = (window.APP_CONFIG && window.APP_CONFIG.PROFILE_ID) || 'default';
        return `${PREFIX}${pid}_${name}`;
    }

    function safeJSON(str, fallback) {
        if (str === null || str === undefined) return fallback;
        try { return JSON.parse(str) || fallback; }
        catch { return fallback; }
    }

    window.DB = {
        // --- Profile ---
        getProfile: function() {
            return {
                id   : (window.APP_CONFIG && window.APP_CONFIG.PROFILE_ID)   || 'default',
                name : (window.APP_CONFIG && window.APP_CONFIG.PROFILE_NAME) || 'User'
            };
        },

        // --- API Key (stored separately, not profile-bound) ---
        getAPIKey: function() {
            return localStorage.getItem(`${PREFIX}api_key`) || '';
        },
        setAPIKey: function(k) {
            localStorage.setItem(`${PREFIX}api_key`, k || '');
        },

        // --- Preferences ---
        getPref: function(name, fallback) {
            const v = localStorage.getItem(key('pref_' + name));
            return v !== null ? v : fallback;
        },
        setPref: function(name, val) {
            localStorage.setItem(key('pref_' + name), val);
        },

        // --- Vocabulary Notebook ---
        loadNotebook: function() {
            return safeJSON(localStorage.getItem(key('notebook')), []);
        },
        saveNotebook: function(arr) {
            localStorage.setItem(key('notebook'), JSON.stringify(arr || []));
        },
        upsertNotebookWord: function(entry) {
            const nb    = this.loadNotebook();
            const wLow  = String(entry.word || '').toLowerCase();
            const idx   = nb.findIndex(w => String(w.word || '').toLowerCase() === wLow);

            const item = {
                word       : entry.word,
                meaning    : entry.meaning    || '',
                enDef      : entry.enDef      || '',
                collo      : entry.collo      || '',
                colloCn    : entry.colloCn    || '',
                register   : entry.register   || 'neutral',
                context    : entry.context    || '',
                contextCn  : entry.contextCn  || '',
                phonetic   : entry.phonetic   || '',
                note       : entry.note       || '',
                tags       : Array.isArray(entry.tags) ? entry.tags : [],
                focus      : Array.isArray(entry.focus) ? entry.focus : [],
                source     : entry.source     || '',
                addedAt    : entry.addedAt    || Date.now(),
                reviewedAt : entry.reviewedAt || 0,
                strength   : entry.strength   || 0,
                wrongCount    : entry.wrongCount    || 0,
                correctStreak : entry.correctStreak || 0
            };

            if (idx >= 0) {
                // Merge: keep existing fields if new ones are empty
                const old = nb[idx];
                Object.keys(item).forEach(k => {
                    if (k === 'word' || k === 'addedAt') return;
                    // For arrays, keep old if new is empty
                    if (Array.isArray(item[k]) && item[k].length === 0 && Array.isArray(old[k]) && old[k].length > 0) {
                        item[k] = old[k];
                        return;
                    }
                    if (!item[k] && old[k]) item[k] = old[k];
                });
                nb[idx] = item;
            } else {
                nb.push(item);
            }
            this.saveNotebook(nb);
            return item;
        },
        removeNotebookWord: function(word) {
            const nb   = this.loadNotebook();
            const wLow = String(word || '').toLowerCase();
            const next = nb.filter(w => String(w.word || '').toLowerCase() !== wLow);
            this.saveNotebook(next);
        },
        toggleFocus: function(word, focusType) {
            const nb   = this.loadNotebook();
            const wLow = String(word || '').toLowerCase();
            const idx  = nb.findIndex(w => String(w.word || '').toLowerCase() === wLow);
            if (idx < 0) return false;
            const w     = nb[idx];
            const focus = Array.isArray(w.focus) ? [...w.focus] : [];
            const i     = focus.indexOf(focusType);
            if (i >= 0) focus.splice(i, 1);
            else        focus.push(focusType);
            w.focus = focus;
            nb[idx] = w;
            this.saveNotebook(nb);
            return focus.includes(focusType);
        },

        // --- Writing History ---
        loadWritingHistory: function() {
            return safeJSON(localStorage.getItem(key('writing_history')), []);
        },
        saveWritingEntry: function(entry) {
            const history = this.loadWritingHistory();
            entry.id        = entry.id || `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            entry.timestamp = entry.timestamp || Date.now();
            history.unshift(entry);
            // Keep last 200 entries
            if (history.length > 200) history.length = 200;
            localStorage.setItem(key('writing_history'), JSON.stringify(history));
            return entry;
        },
        deleteWritingEntry: function(id) {
            const history = this.loadWritingHistory().filter(e => e.id !== id);
            localStorage.setItem(key('writing_history'), JSON.stringify(history));
        },

        // --- Statistics ---
        loadStats: function() {
            return safeJSON(localStorage.getItem(key('stats')), {
                totalSessions    : 0,
                totalCorrections : 0,
                avgScore         : 0,
                streakDays       : 0,
                lastActiveDate   : null,
                modeUsage        : {}
            });
        },
        saveStats: function(stats) {
            localStorage.setItem(key('stats'), JSON.stringify(stats || {}));
        },
        bumpSession: function(mode, score) {
            const stats   = this.loadStats();
            const today   = new Date().toISOString().slice(0, 10);

            stats.totalSessions++;
            if (typeof score === 'number') {
                const prev    = stats.avgScore || 0;
                const n       = stats.totalSessions;
                stats.avgScore = Math.round(((prev * (n - 1)) + score) / n);
            }

            // Streak
            if (stats.lastActiveDate === today) {
                // same day, no change
            } else {
                const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
                stats.streakDays = (stats.lastActiveDate === yesterday)
                    ? (stats.streakDays || 0) + 1
                    : 1;
            }
            stats.lastActiveDate = today;

            // Mode usage
            if (mode) {
                stats.modeUsage       = stats.modeUsage || {};
                stats.modeUsage[mode] = (stats.modeUsage[mode] || 0) + 1;
            }

            this.saveStats(stats);
            return stats;
        },

        // --- Export / Import ---
        exportAll: function() {
            const pid  = (window.APP_CONFIG && window.APP_CONFIG.PROFILE_ID) || 'default';
            const data = {};
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(`${PREFIX}${pid}_`)) {
                    data[k] = localStorage.getItem(k);
                }
            }
            data[`${PREFIX}api_key`] = localStorage.getItem(`${PREFIX}api_key`) || '';
            return JSON.stringify(data, null, 2);
        },
        importAll: function(jsonStr) {
            const data = safeJSON(jsonStr, null);
            if (!data) return false;
            Object.keys(data).forEach(k => {
                if (k.startsWith(PREFIX)) {
                    localStorage.setItem(k, data[k]);
                }
            });
            return true;
        },

        // --- Factory Reset ---
        factoryReset: function() {
            const pid = (window.APP_CONFIG && window.APP_CONFIG.PROFILE_ID) || 'default';
            const toRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(`${PREFIX}${pid}_`)) {
                    toRemove.push(k);
                }
            }
            toRemove.forEach(k => localStorage.removeItem(k));
        }
    };
})();
