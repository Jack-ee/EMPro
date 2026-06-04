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
        'further':['far'],'furthest':['far'],'farther':['far'],'farthest':['far'],
        // Additional irregular verbs (past / past participle / -ing).
        'began':['begin'],'begun':['begin'],'beginning':['begin'],
        'drove':['drive'],'driven':['drive'],'driving':['drive'],
        'rose':['rise'],'risen':['rise'],'rising':['rise'],
        'fell':['fall'],'fallen':['fall'],'falling':['fall'],
        'flew':['fly'],'flown':['fly'],'flying':['fly'],
        'grew':['grow'],'grown':['grow'],'growing':['grow'],
        'threw':['throw'],'thrown':['throw'],'throwing':['throw'],
        'blew':['blow'],'blown':['blow'],'blowing':['blow'],
        'froze':['freeze'],'frozen':['freeze'],'freezing':['freeze'],
        'stole':['steal'],'stolen':['steal'],'stealing':['steal'],
        'swam':['swim'],'swum':['swim'],'swimming':['swim'],
        'sang':['sing'],'sung':['sing'],'singing':['sing'],
        'drank':['drink'],'drunk':['drink'],'drinking':['drink'],
        'rang':['ring'],'rung':['ring'],'ringing':['ring'],
        'sat':['sit'],'sitting':['sit'],
        'stood':['stand'],'standing':['stand'],
        'understood':['understand'],'understanding':['understand'],
        'won':['win'],'winning':['win'],
        'sent':['send'],'sending':['send'],
        'spent':['spend'],'spending':['spend'],
        'built':['build'],'building':['build'],
        'felt':['feel'],'feeling':['feel'],
        'kept':['keep'],'keeping':['keep'],
        'slept':['sleep'],'sleeping':['sleep'],
        'meant':['mean'],'meaning':['mean'],
        'dealt':['deal'],'dealing':['deal'],
        'left':['leave'],'leaving':['leave'],
        'heard':['hear'],'hearing':['hear'],
        'paid':['pay'],'paying':['pay'],
        'laid':['lay'],'laying':['lay'],
        'became':['become'],'becoming':['become'],
        'forgot':['forget'],'forgotten':['forget'],'forgetting':['forget'],
        'wore':['wear'],'worn':['wear'],'wearing':['wear'],
        'tore':['tear'],'torn':['tear'],'tearing':['tear'],
        'bore':['bear'],'borne':['bear'],'bearing':['bear'],
        'beat':['beat'],'beaten':['beat'],'beating':['beat'],
        'bit':['bite'],'bitten':['bite'],'biting':['bite'],
        'hid':['hide'],'hidden':['hide'],'hiding':['hide'],
        'rode':['ride'],'ridden':['ride'],'riding':['ride'],
        'shook':['shake'],'shaken':['shake'],'shaking':['shake'],
        'woke':['wake'],'woken':['wake'],'waking':['wake'],
        'shone':['shine'],'shining':['shine'],
        'shot':['shoot'],'shooting':['shoot'],
        'hung':['hang'],'hanging':['hang'],
        'sold':['sell'],'selling':['sell'],
        'fed':['feed'],'feeding':['feed'],
        'fled':['flee'],'fleeing':['flee'],
        'lit':['light'],'lighting':['light'],
        'slid':['slide'],'sliding':['slide'],
        'struck':['strike'],'striking':['strike'],
        'swung':['swing'],'swinging':['swing'],
        'sank':['sink'],'sunk':['sink'],'sinking':['sink'],
        'fought':['fight'],'fighting':['fight'],
        'sought':['seek'],'seeking':['seek'],
        'bent':['bend'],'bending':['bend'],
        'lent':['lend'],'lending':['lend'],
        'swept':['sweep'],'sweeping':['sweep'],
        'wept':['weep'],'weeping':['weep'],
        'crept':['creep'],'creeping':['creep'],
        'cutting':['cut'],'hitting':['hit'],'letting':['let'],
        'shutting':['shut'],'spreading':['spread'],'casting':['cast'],
        'costing':['cost'],'hurting':['hurt'],
        'forgave':['forgive'],'forgiven':['forgive'],'forgiving':['forgive'],
        'withdrew':['withdraw'],'withdrawn':['withdraw'],
        'arose':['arise'],'arisen':['arise'],'arising':['arise'],
        // Latin / Greek plurals → singular.
        'analyses':['analysis'],'crises':['crisis'],'theses':['thesis'],
        'hypotheses':['hypothesis'],'parentheses':['parenthesis'],
        'diagnoses':['diagnosis'],'criteria':['criterion'],
        'phenomena':['phenomenon'],'data':['datum'],'media':['medium'],
        'bacteria':['bacterium'],'curricula':['curriculum'],
        'memoranda':['memorandum'],'addenda':['addendum'],
        'indices':['index'],'matrices':['matrix'],'vertices':['vertex'],
        'appendices':['appendix'],'formulae':['formula'],'antennae':['antenna'],
        'alumni':['alumnus'],'fungi':['fungus'],'cacti':['cactus'],
        'nuclei':['nucleus'],'radii':['radius'],'syllabi':['syllabus'],
        'stimuli':['stimulus'],'foci':['focus']
    };

    // Common adjectives that double the final consonant in the
    // comparative / superlative (big → bigger). Kept as an explicit
    // allowlist so we never false-positive on agent nouns or verbs
    // (e.g. bet → better) from a blind doubling rule.
    const CVC_ADJ = new Set([
        'big','hot','thin','fat','sad','wet','fit','flat','slim','dim',
        'red','mad','glad','grim','tan','big'
    ]);

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

        // Comparatives / superlatives: a blind base+'er' rule collides
        // with agent nouns (work→worker, teach→teacher), so we only
        // generate the consonant-doubling forms for the known CVC
        // adjective allowlist (big→bigger, hot→hottest). Regular -er/
        // -est adjectives are left to the irregular table or to exact /
        // INPUT-field matching, which is the precise path.
        if (CVC_ADJ.has(b)) {
            const dbl = b + b.slice(-1);
            cand.add(dbl + 'er');
            cand.add(dbl + 'est');
        }

        return cand.has(a);
    }

    // ─── Streak helpers ──────────────────────────────────────
    // Local calendar date (YYYY-MM-DD) in the user's timezone — NOT UTC.
    // toISOString().slice(0,10) gives the UTC date, which rolls early or
    // late depending on timezone (China is UTC+8, so a UTC date lags a
    // day) and would mis-count streaks.
    function _localYMD(d) {
        const dd = d || new Date();
        const y  = dd.getFullYear();
        const m  = String(dd.getMonth() + 1).padStart(2, '0');
        const da = String(dd.getDate()).padStart(2, '0');
        return `${y}-${m}-${da}`;
    }

    // Advance the daily streak on `stats` if today has not been counted
    // yet. Idempotent within a calendar day. Mutates and returns `stats`
    // but does NOT persist — the caller decides when to save.
    function _advanceStreak(stats) {
        const today = _localYMD();
        if (stats.lastActiveDate === today) return stats;  // already counted today
        const yd = new Date();
        yd.setDate(yd.getDate() - 1);
        const yesterday = _localYMD(yd);
        stats.streakDays = (stats.lastActiveDate === yesterday)
            ? (stats.streakDays || 0) + 1
            : 1;
        stats.lastActiveDate = today;
        return stats;
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
        upsertNotebookWord: function(entry, opts) {
            const nb       = this.loadNotebook();
            const wLow     = String(entry.word || '').trim().toLowerCase();
            const matchLow = String((opts && opts.matchWord) || '').trim().toLowerCase();

            // 0) Explicit match key — the exact word the user already
            // stored (e.g. an inflected form "squeezed"). Supplied by the
            // batch importer via the AI-echoed INPUT field. This is the
            // precise path: it does not rely on inflection heuristics, so
            // a base form returned by the AI ("squeeze") still updates the
            // original row instead of creating an orphan duplicate.
            let idx = -1;
            if (matchLow) {
                idx = nb.findIndex(w => String(w.word || '').trim().toLowerCase() === matchLow);
            }

            // 1) Exact match on the canonical word.
            if (idx < 0) {
                idx = nb.findIndex(w => String(w.word || '').trim().toLowerCase() === wLow);
            }

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
                correctStreak : entry.correctStreak || 0,
                // Stable index for audio-pack range builds. 0 means it is
                // not assigned yet; the app assigns a permanent number on
                // export. The merge loop below preserves an existing
                // non-zero index, so enriching a word never renumbers it.
                packIndex     : entry.packIndex     || 0
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
            // Drop the word's offline pack audio too, so the pack store
            // does not keep clips for vocabulary that has been removed.
            try { window.TTSPack && window.TTSPack.deleteWord(word); }
            catch (e) { /* ignore */ }
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

        // --- Spaced Repetition (SRS) ---
        // Each word can carry optional review state. All fields are optional;
        // a word with none of them is treated as "new, due now". This means
        // existing words from before this feature shipped automatically appear
        // in the Due filter without any migration step.
        //
        // Word fields used here:
        //   srsLevel    — integer 0..5 (0 = new / failed, 5 = mastered)
        //   nextReview  — ms-since-epoch; null/missing = due now
        //   lastReview  — ms-since-epoch of most recent review
        //   reviewCount — total reviews ever performed
        //   mistakeCount — total times marked "wrong"
        //
        // Intervals (in days), indexed by level after the review:
        //   level 0  → 1
        //   level 1  → 3
        //   level 2  → 7
        //   level 3  → 14
        //   level 4  → 30
        //   level 5+ → 60
        // Easy clicks scale these by ~2x (e.g. 60 → 120 days at level 5).

        SRS_INTERVALS: [1, 3, 7, 14, 30, 60],

        // Pure scheduler — given a current level and a result, returns
        // the new level and how many days until the next review.
        // Exposed so other modules (e.g. the future Mistake Bank) can
        // reuse the same logic.
        scheduleReview: function(currentLevel, result) {
            const lvl       = Math.max(0, Math.min(5, Number(currentLevel) || 0));
            const intervals = this.SRS_INTERVALS;
            let newLevel    = lvl;
            let daysToAdd   = 1;
            switch (result) {
                case 'wrong':
                    newLevel  = 0;
                    daysToAdd = 1;
                    break;
                case 'hard':
                    newLevel  = lvl;
                    daysToAdd = 2;
                    break;
                case 'good':
                    newLevel  = Math.min(5, lvl + 1);
                    daysToAdd = intervals[newLevel];
                    break;
                case 'easy':
                    newLevel  = Math.min(5, lvl + 2);
                    daysToAdd = intervals[newLevel] * 2;
                    break;
                default:
                    // Unknown result → safe no-op (treat as good)
                    newLevel  = Math.min(5, lvl + 1);
                    daysToAdd = intervals[newLevel];
            }
            return { newLevel: newLevel, daysToAdd: daysToAdd };
        },

        // Record a review on a word. Returns the updated word entry,
        // or null if the word wasn't found in the notebook.
        recordReview: function(word, result) {
            const nb   = this.loadNotebook();
            const wLow = String(word || '').toLowerCase();
            const idx  = nb.findIndex(w => String(w.word || '').toLowerCase() === wLow);
            if (idx < 0) return null;

            const entry = nb[idx];
            const sched = this.scheduleReview(entry.srsLevel, result);
            const now   = Date.now();

            entry.srsLevel    = sched.newLevel;
            entry.lastReview  = now;
            entry.nextReview  = now + sched.daysToAdd * 86400000;
            entry.reviewCount = (entry.reviewCount || 0) + 1;
            if (result === 'wrong') {
                entry.mistakeCount = (entry.mistakeCount || 0) + 1;
            }

            nb[idx] = entry;
            this.saveNotebook(nb);
            return entry;
        },

        // Words due today (or earlier). Treats missing nextReview as
        // "due now" so the entire pre-SRS notebook surfaces on first use.
        getDueWords: function() {
            const now = Date.now();
            return this.loadNotebook().filter(w => {
                if (w.nextReview == null) return true;
                return Number(w.nextReview) <= now;
            });
        },

        getDueCount: function() {
            return this.getDueWords().length;
        },

        // Aggregate review state across the notebook.
        // Useful for the future learning-record dashboard.
        getReviewStats: function() {
            const nb  = this.loadNotebook();
            const now = Date.now();
            let due = 0, mastered = 0, learning = 0, neverReviewed = 0;
            for (const w of nb) {
                if (w.nextReview == null)                   { due++; neverReviewed++; }
                else if (Number(w.nextReview) <= now)         due++;
                if (Number(w.srsLevel) >= 5)                  mastered++;
                else if (Number(w.srsLevel) > 0)              learning++;
            }
            return {
                total         : nb.length,
                due           : due,
                neverReviewed : neverReviewed,
                learning      : learning,
                mastered      : mastered
            };
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
            const stats = this.loadStats();

            stats.totalSessions++;
            if (typeof score === 'number') {
                const prev    = stats.avgScore || 0;
                const n       = stats.totalSessions;
                stats.avgScore = Math.round(((prev * (n - 1)) + score) / n);
            }

            // Streak (shared, timezone-correct, idempotent per day)
            _advanceStreak(stats);

            // Mode usage
            if (mode) {
                stats.modeUsage       = stats.modeUsage || {};
                stats.modeUsage[mode] = (stats.modeUsage[mode] || 0) + 1;
            }

            this.saveStats(stats);
            return stats;
        },

        // Mark today as an active study day WITHOUT recording a discrete
        // session. Used by continuous-study surfaces (My Words browse / quiz)
        // where there is no natural "session complete" event but the user is
        // clearly active. Idempotent within a calendar day, so it is safe to
        // call on every study gesture — only the first call each day changes
        // anything (and only then does it persist / trigger a sync push).
        // Deliberately leaves totalSessions / modeUsage untouched so the
        // per-session averages stay meaningful.
        markActiveDay: function() {
            const stats  = this.loadStats();
            const before = stats.lastActiveDate;
            _advanceStreak(stats);
            if (stats.lastActiveDate !== before) this.saveStats(stats);
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
        },

        /**
         * Group notebook entries that are inflected forms of one another
         * (cap / capping / caps, collection / collections, ...). Read-only;
         * powers the "Merge word forms" review tool. Returns an array of
         *   { base, members: [{ word, complete, isBase }] }
         * where `base` is the suggested form to keep (the shortest root the
         * others inflect from, tie-broken toward the more-complete entry) and
         * `members` are ALL forms in the group (base included, flagged via
         * isBase). Only groups with 2+ entries are returned.
         */
        findInflectionGroups: function() {
            const nb    = this.loadNotebook();
            const n     = nb.length;
            const words = nb.map(w => String((w && w.word) || '').trim());

            // Union-Find over indices: two entries join a group when either
            // is a plausible inflection of the other.
            const parent = Array.from({ length: n }, (_, i) => i);
            const find   = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
            const union  = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

            for (let i = 0; i < n; i++) {
                if (!words[i]) continue;
                for (let j = i + 1; j < n; j++) {
                    if (!words[j]) continue;
                    if (isInflectionOf(words[i], words[j]) || isInflectionOf(words[j], words[i])) union(i, j);
                }
            }

            const isComplete = (w) => Boolean(w && (w.meaning || w.enDef) && (w.collo || w.example || w.context));

            const clusters = {};
            for (let i = 0; i < n; i++) {
                if (!words[i]) continue;
                const r = find(i);
                (clusters[r] = clusters[r] || []).push(i);
            }

            const groups = [];
            Object.keys(clusters).forEach(rootKey => {
                const idxs = clusters[rootKey];
                if (idxs.length < 2) return;

                // A "root" is a member that is not an inflection of any OTHER
                // member (i.e. the base form). Prefer the shortest root, then
                // the more-complete entry, then alphabetical for stability.
                const isRoot = (i) => !idxs.some(j => j !== i && isInflectionOf(words[i], words[j]));
                let roots = idxs.filter(isRoot);
                if (roots.length === 0) roots = idxs.slice();
                roots.sort((a, b) => {
                    if (words[a].length !== words[b].length) return words[a].length - words[b].length;
                    const ca = isComplete(nb[a]) ? 0 : 1;
                    const cb = isComplete(nb[b]) ? 0 : 1;
                    if (ca !== cb) return ca - cb;
                    return words[a].localeCompare(words[b]);
                });
                const baseIdx = roots[0];

                const members = idxs
                    .slice()
                    .sort((a, b) => words[a].localeCompare(words[b]))
                    .map(i => ({
                        index    : i,
                        word     : words[i],
                        complete : isComplete(nb[i]),
                        isBase   : i === baseIdx,
                        hint     : String((nb[i] && (nb[i].meaning || nb[i].enDef)) || '').slice(0, 48)
                    }));

                groups.push({ base: words[baseIdx], members });
            });

            // Most-actionable groups first (more forms = more clutter removed).
            groups.sort((a, b) => b.members.length - a.members.length);
            return groups;
        },

        /**
         * Merge groups of notebook entries by INDEX, in one atomic pass.
         * Keying on indices (not word strings) is essential: a group can hold
         * two entries with the identical word (a true duplicate), which a
         * string key cannot tell apart. All operations run against a single
         * snapshot, so indices stay valid; the notebook is saved once.
         *
         *   operations: [{ keepIndex, dropIndices: [..] }, ...]
         *
         * For each op, every drop entry is folded into its keep entry — the
         * keep entry's own non-empty fields win, its blanks are filled from
         * the drops, array fields (focus tags, ...) are unioned, the earliest
         * addedAt is preserved — then the drops are removed.
         * Returns { merged, groups }: entries removed, and groups affected.
         */
        mergeGroups: function(operations) {
            const nb     = this.loadNotebook();
            const remove = new Set();
            let merged = 0, groups = 0;

            (operations || []).forEach(op => {
                const keepIndex = (op && Number.isInteger(op.keepIndex)) ? op.keepIndex : -1;
                const drops     = (op && Array.isArray(op.dropIndices)) ? op.dropIndices : [];
                const keep      = nb[keepIndex];
                if (!keep) return;

                let any = false;
                drops.forEach(di => {
                    if (di === keepIndex || remove.has(di)) return;
                    const w = nb[di];
                    if (!w) return;
                    Object.keys(w).forEach(k => {
                        if (k === 'word' || k === 'addedAt') return;
                        if (Array.isArray(w[k])) {
                            const base = Array.isArray(keep[k]) ? keep[k] : [];
                            const seen = new Set(base);
                            w[k].forEach(v => { if (!seen.has(v)) { base.push(v); seen.add(v); } });
                            keep[k] = base;
                            return;
                        }
                        const empty = keep[k] === undefined || keep[k] === null || keep[k] === '';
                        if (empty && w[k] !== undefined && w[k] !== null && w[k] !== '') keep[k] = w[k];
                    });
                    if (w.addedAt && (!keep.addedAt || w.addedAt < keep.addedAt)) keep.addedAt = w.addedAt;
                    remove.add(di);
                    merged++;
                    any = true;
                });
                if (any) groups++;
            });

            if (remove.size === 0) return { merged: 0, groups: 0 };
            const next = nb.filter((_, i) => !remove.has(i));
            this.saveNotebook(next);
            console.log(`[DB] mergeGroups: removed ${remove.size} entr${remove.size === 1 ? 'y' : 'ies'} across ${groups} group(s).`);
            return { merged, groups };
        }
    };
})();
