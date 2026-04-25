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

    // ─── Lemma matcher ───────────────────────────────────────
    // Tests whether `inflected` is a plausible English inflection of
    // `base`. Designed for precision over recall — false negatives just
    // mean a word silently won't match and the existing "create new
    // row" behavior kicks in (annoying, not corrupting). False
    // positives could merge unrelated words, so we err on caution.
    // Covers the cases described in the memory note about inflected
    // forms (proved/prove, collections/collection, etc.).
    const IRREGULAR = {
        'am':['be'],'is':['be'],'are':['be'],'was':['be'],'were':['be'],'been':['be'],'being':['be'],
        'has':['have'],'had':['have'],'having':['have'],
        'does':['do'],'did':['do'],'done':['do'],'doing':['do'],
        'goes':['go'],'went':['go'],'gone':['go'],'going':['go'],
        'ran':['run'],'running':['run'],
        'saw':['see'],'seen':['see'],'seeing':['see'],
        'ate':['eat'],'eaten':['eat'],'eating':['eat'],
        'took':['take'],'taken':['take'],'taking':['take'],
        'gave':['give'],'given':['give'],'giving':['give'],
        'came':['come'],'coming':['come'],
        'made':['make'],'making':['make'],
        'knew':['know'],'known':['know'],'knowing':['know'],
        'thought':['think'],'thinking':['think'],
        'brought':['bring'],'bringing':['bring'],
        'bought':['buy'],'buying':['buy'],
        'caught':['catch'],'catching':['catch'],
        'taught':['teach'],'teaching':['teach'],
        'said':['say'],'saying':['say'],
        'told':['tell'],'telling':['tell'],
        'found':['find'],'finding':['find'],
        'got':['get'],'gotten':['get'],'getting':['get'],
        'putting':['put'],
        'setting':['set'],
        'lost':['lose'],'losing':['lose'],
        'held':['hold'],'holding':['hold'],
        'led':['lead'],'leading':['lead'],
        'met':['meet'],'meeting':['meet'],
        'reading':['read'],
        'wrote':['write'],'written':['write'],'writing':['write'],
        'spoke':['speak'],'spoken':['speak'],'speaking':['speak'],
        'broke':['break'],'broken':['break'],'breaking':['break'],
        'chose':['choose'],'chosen':['choose'],'choosing':['choose'],
        'drew':['draw'],'drawn':['draw'],
        'men':['man'],'women':['woman'],'children':['child'],
        'feet':['foot'],'teeth':['tooth'],'mice':['mouse'],'geese':['goose'],'people':['person'],
        'better':['good','well'],'best':['good','well'],
        'worse':['bad','ill'],'worst':['bad','ill'],
        'more':['many','much'],'most':['many','much'],
        'less':['little'],'least':['little'],
        'further':['far'],'furthest':['far'],'farther':['far'],'farthest':['far']
    };

    function _isCVC(w) {
        if (w.length < 2) return false;
        if (/[wxy]$/.test(w)) return false;
        return /[^aeiou][aeiou][^aeiou]$/i.test(w);
    }

    function isInflectionOf(inflected, base) {
        const a = String(inflected || '').trim().toLowerCase();
        const b = String(base       || '').trim().toLowerCase();
        if (!a || !b) return false;

        // Identity
        if (a === b) return true;

        // Irregulars
        const bases = IRREGULAR[a];
        if (bases && bases.includes(b)) return true;

        // Regulars: inflected must be longer than base
        if (a.length <= b.length) return false;

        // Skip regular rules for phrases
        if (a.includes(' ') || b.includes(' ')) return false;

        const cand = new Set();

        // Plurals / 3rd-singular
        cand.add(b + 's');
        cand.add(b + 'es');
        if (/[^aeiou]y$/.test(b)) cand.add(b.slice(0, -1) + 'ies');
        if (/f$/.test(b))         cand.add(b.slice(0, -1) + 'ves');
        if (/fe$/.test(b))        cand.add(b.slice(0, -2) + 'ves');

        // Past tense / past participle
        if (/e$/.test(b)) {
            cand.add(b + 'd');
        } else {
            cand.add(b + 'ed');
            if (/[^aeiou]y$/.test(b)) cand.add(b.slice(0, -1) + 'ied');
            if (_isCVC(b))            cand.add(b + b.slice(-1) + 'ed');
        }

        // Present participle / gerund
        if (/ie$/.test(b)) {
            cand.add(b.slice(0, -2) + 'ying');
        } else if (/e$/.test(b) && !/ee$/.test(b)) {
            cand.add(b.slice(0, -1) + 'ing');
        } else {
            cand.add(b + 'ing');
            if (_isCVC(b)) cand.add(b + b.slice(-1) + 'ing');
        }

        // Adverb -ly
        cand.add(b + 'ly');
        if (/y$/.test(b) && !/[aeou]y$/.test(b)) cand.add(b.slice(0, -1) + 'ily');

        // Comparatives: NOT generated from rules — irregular table
        // handles good/better/best etc. Regular rules would cause
        // false positives like bet→better.

        return cand.has(a);
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
            const wLow  = String(entry.word || '').trim().toLowerCase();

            // 1) Exact match (unchanged behavior)
            let idx = nb.findIndex(w => String(w.word || '').trim().toLowerCase() === wLow);

            // 2) Lemma match: look for any existing entry whose stored
            // word is a plausible inflection of the incoming `word`.
            // Runs only if the exact match failed. The incoming word
            // is assumed to be a base form (that's what the batch-
            // enrich prompt asks the AI to return).
            let matchedViaLemma = false;
            if (idx < 0 && wLow) {
                idx = nb.findIndex(w => isInflectionOf(String(w.word || ''), wLow));
                if (idx >= 0) matchedViaLemma = true;
            }

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
                // Merge: keep existing fields if new ones are empty.
                // When lemma-matched, we DO overwrite the stored
                // word with the canonical base form so the notebook
                // standardizes on lemmas (squeezed → squeeze).
                const old = nb[idx];
                Object.keys(item).forEach(k => {
                    if (k === 'addedAt') return;
                    if (k === 'word') {
                        // Lemma match: adopt the canonical base form
                        // Exact match: already equal, no-op
                        return;
                    }
                    if (Array.isArray(item[k]) && item[k].length === 0 && Array.isArray(old[k]) && old[k].length > 0) {
                        item[k] = old[k];
                        return;
                    }
                    if (!item[k] && old[k]) item[k] = old[k];
                });
                // Preserve original addedAt
                item.addedAt = old.addedAt || item.addedAt;
                if (matchedViaLemma) {
                    console.log(`[DB] Lemma-matched "${old.word}" → "${item.word}", merged.`);
                }
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
        // exportAll(opts) — opts.includeApiKey (default false): when true,
        // bundles `emp_api_key` into the backup. The API key is plaintext;
        // omitting it by default protects users who share backup files.
        // The sync token and gist id are NEVER exported — they're device-
        // local credentials, not learning data.
        exportAll: function(opts) {
            const includeApiKey = Boolean(opts && opts.includeApiKey);
            const pid           = (window.APP_CONFIG && window.APP_CONFIG.PROFILE_ID) || 'default';
            const data          = {};
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(`${PREFIX}${pid}_`)) {
                    data[k] = localStorage.getItem(k);
                }
            }
            if (includeApiKey) {
                const apiKey = localStorage.getItem(`${PREFIX}api_key`) || '';
                if (apiKey) data[`${PREFIX}api_key`] = apiKey;
            }
            return JSON.stringify(data, null, 2);
        },

        // importAll(jsonStr, opts) — opts.replace (default false):
        //   • replace=true: clear all current profile keys before applying the
        //     backup. This is true overwrite — stale words, history, and
        //     prefs that aren't in the backup are removed.
        //   • replace=false: merge — incoming keys are written, but existing
        //     keys not present in the backup are preserved (legacy behavior).
        // The shared API key (`emp_api_key`) is touched only if the backup
        // contains it; otherwise the local key is preserved either way.
        importAll: function(jsonStr, opts) {
            const data = safeJSON(jsonStr, null);
            if (!data) return false;
            const replace = Boolean(opts && opts.replace);

            if (replace) {
                const pid    = (window.APP_CONFIG && window.APP_CONFIG.PROFILE_ID) || 'default';
                const prefix = `${PREFIX}${pid}_`;
                const drop   = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith(prefix)) drop.push(k);
                }
                drop.forEach(k => localStorage.removeItem(k));
            }

            Object.keys(data).forEach(k => {
                if (k.startsWith(PREFIX)) {
                    localStorage.setItem(k, data[k]);
                }
            });
            return true;
        },

        // --- Factory Reset ---
        // factoryReset(opts) — opts.clearCredentials (default false):
        //   • false: only profile-prefixed learning data is wiped; API key,
        //     GitHub sync token, and Gist id are preserved (matches the
        //     historical behavior so a "reset" doesn't surprise-revoke
        //     credentials the user already configured).
        //   • true: also clears `emp_api_key`, `emp_sync_token`,
        //     `emp_sync_gist_id`, and the sync timestamp markers, for a
        //     true full-wipe (e.g. handing the device to someone else).
        factoryReset: function(opts) {
            const clearCreds = Boolean(opts && opts.clearCredentials);
            const pid        = (window.APP_CONFIG && window.APP_CONFIG.PROFILE_ID) || 'default';
            const toRemove   = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(`${PREFIX}${pid}_`)) {
                    toRemove.push(k);
                }
            }
            toRemove.forEach(k => localStorage.removeItem(k));
            if (clearCreds) {
                [
                    `${PREFIX}api_key`,
                    'emp_sync_token',
                    'emp_sync_gist_id',
                    'emp_sync_last_pull',
                    'emp_sync_last_push',
                    'emp_sync_v2_fix_applied'
                ].forEach(k => localStorage.removeItem(k));
            }
        },

        // --- Lemma utilities (exposed for debugging / sweeps) ---

        /**
         * Test whether one word is a plausible English inflection of another.
         * Useful from DevTools to verify match behavior:
         *   window.DB.isInflectionOf('squeezed', 'squeeze')  // true
         */
        isInflectionOf: isInflectionOf,

        /**
         * One-time sweep: find notebook entries where the stored word is
         * an inflection of another stored word, and merge them into the
         * base-form entry. Useful after a botched paste-back to clean
         * up duplicates like [squeezed (incomplete), squeeze (enriched)].
         *
         * Returns { merged, removed } counts. Dry run by default — pass
         * `{apply: true}` to actually modify the notebook.
         */
        dedupByLemma: function(opts) {
            const apply = Boolean(opts && opts.apply);
            const nb    = this.loadNotebook();
            const keep  = nb.slice();
            const actions = [];

            // For each pair (i, j) where keep[i] is an inflection of keep[j],
            // merge i into j. We iterate with a "dropped" set to avoid
            // merging the same entry twice.
            const dropped = new Set();

            for (let i = 0; i < keep.length; i++) {
                if (dropped.has(i)) continue;
                const wi = String(keep[i]?.word || '').trim();
                if (!wi) continue;

                for (let j = 0; j < keep.length; j++) {
                    if (i === j || dropped.has(j)) continue;
                    const wj = String(keep[j]?.word || '').trim();
                    if (!wj) continue;

                    // Is wi an inflection of wj?
                    if (isInflectionOf(wi, wj)) {
                        // Merge i into j: for each field, prefer non-empty value
                        const a = keep[i], b = keep[j];
                        Object.keys(a).forEach(k => {
                            if (k === 'word' || k === 'addedAt') return;
                            if (Array.isArray(b[k]) && b[k].length === 0 && Array.isArray(a[k]) && a[k].length > 0) {
                                b[k] = a[k];
                                return;
                            }
                            if (!b[k] && a[k]) b[k] = a[k];
                        });
                        // Keep earliest addedAt
                        if (a.addedAt && (!b.addedAt || a.addedAt < b.addedAt)) b.addedAt = a.addedAt;
                        actions.push({ drop: wi, keep: wj });
                        dropped.add(i);
                        break;
                    }
                }
            }

            const next = keep.filter((_, i) => !dropped.has(i));
            const result = { merged: actions.length, removed: dropped.size, actions, dryRun: !apply };

            if (apply) {
                this.saveNotebook(next);
            }
            console.log(`[DB] dedupByLemma: ${apply ? 'APPLIED' : 'DRY RUN'} — would merge ${actions.length} entries.`);
            actions.forEach(a => console.log(`  merge "${a.drop}" → "${a.keep}"`));
            return result;
        }
    };
})();
