/**
 * stories.js - EMPro reading material generator
 * ============================================================
 * Turns the vocabulary notebook into short reading pieces (stories,
 * paragraphs, dialogues) a batch at a time, so a 500-word bank becomes
 * 25 pieces of 20 words instead of one unreadable wall of text.
 *
 * The loop
 *   1. Pick how many words this run and how many words per piece
 *      (e.g. 100 words, 20 per piece -> 5 pieces).
 *   2. "Copy prompt" reserves those words: one PENDING piece per group is
 *      written to storage immediately, so the next run never hands out the
 *      same words again. Deleting a piece releases its words back.
 *   3. Paste the AI's JSON back. Each piece is matched by its seq number
 *      and becomes READY: title, sentences, per-sentence Chinese.
 *   4. Read it in the app, sentence by sentence, target words highlighted.
 *   5. Export the audio word list. Story sentences ride along in the same
 *      wordlist.txt as the vocabulary, so the existing GitHub Actions +
 *      OpenAI TTS build gives every sentence a native voice clip.
 *
 * Storage
 *   One preference key, 'stories' (emp_<profile>_pref_stories), so the
 *   whole set rides the existing Gist sync with no sync-side changes.
 *
 * Audio pack indices
 *   A piece's block index in wordlist.txt is PACK_BASE + seq (10001, ...).
 *   Vocabulary packIndex values start at 1, so the two can never collide,
 *   and "# range: 10001-10999" builds story audio without touching the
 *   word clips. The generator prunes only entries missing from the whole
 *   list, never from the selected range, so a story-range build keeps
 *   every existing word clip.
 *
 * Public API (window.Stories)
 *   init()                     wire the view
 *   PACK_BASE                  story block index offset (10000)
 *   speechBlocks()             [{index, word, entries[]}] for wordlist.txt
 *   speechList()               flat sentence list for the coverage readout
 *   load() / save(arr)         the story array
 *   planBatch(opts)            {groups, taken, remaining, poolSize}
 *   buildPrompt(stories, opts) the prompt text
 *   parseResponse(text)        pieces found in a pasted AI reply
 *   applyResponse(text)        parse + write; {filled, unmatched, gaps}
 * ============================================================
 */
window.Stories = (function () {
    'use strict';

    // A story's wordlist.txt block index is PACK_BASE + seq. Vocabulary
    // indices count up from 1 and the bank is in the hundreds, so 10000
    // leaves room for ~9500 words before the two spaces could meet.
    const PACK_BASE   = 10000;
    const STORE_PREF  = 'stories';
    const MAX_GROUPS  = 12;      // pieces per run; more than this is a
                                 // single AI reply too long to come back
                                 // intact, so the run is capped.
    const TYPE_LABEL  = {
        story     : 'a short story with a clear beginning, turn, and ending',
        paragraph : 'one informative paragraph on a single topic',
        dialogue  : 'a natural dialogue between two speakers, marked "A:" and "B:"',
        news      : 'a news brief written in journalistic style'
    };

    let playToken = null;        // App session token while reading aloud
    let playStop  = false;       // cancel flag for sequential playback
    let openId    = null;        // id of the piece open in the reader

    // ─── Text helpers ────────────────────────────────────────

    function norm(s) {
        return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
    }

    // Sentence text as it is stored, exported, and spoken. A leading '#'
    // would be read as a comment line by the pack generator, so it is
    // stripped here, once, at store time. Export and playback then share
    // one string and the pack key always matches.
    function clean(s) {
        return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim();
    }

    function esc(s)     { return window.App?.escHtml?.(s) ?? String(s == null ? '' : s); }
    function escA(s)    { return window.App?.escAttr?.(s) ?? String(s == null ? '' : s); }
    function toast(m, ms) { window.App?.showToast?.(m, ms); }

    // ─── Storage ─────────────────────────────────────────────

    function load() {
        try {
            const raw = window.DB?.getPref?.(STORE_PREF, '') || '';
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            console.warn('[stories] could not read store:', e && e.message);
            return [];
        }
    }

    // Returns false when the write failed (a full localStorage quota is
    // the realistic case, since this origin is shared with other apps).
    function save(arr) {
        try {
            window.DB?.setPref?.(STORE_PREF, JSON.stringify(arr || []));
            return true;
        } catch (e) {
            console.error('[stories] save failed:', e && e.message);
            toast('Could not save \u2014 device storage is full. Delete a few pieces and try again.', 6000);
            return false;
        }
    }

    function byId(id)   { return load().find(s => s && s.id === id) || null; }
    function nextSeq(a) { return a.reduce((m, s) => Math.max(m, Number(s && s.seq) || 0), 0) + 1; }

    function pref(name, fallback) { return window.DB?.getPref?.('sy_' + name, fallback) ?? fallback; }
    function setPref(name, val)   { try { window.DB?.setPref?.('sy_' + name, val); } catch (e) {} }

    // ─── Word source ─────────────────────────────────────────

    // Notebook order for batching: packIndex first (the permanent audio
    // index, assigned in the order words were added), then addedAt for
    // words that have never been exported. Stable, so "the first 100
    // words" means the same 100 words on every device.
    function orderedWords() {
        return (window.DB?.loadNotebook?.() || [])
            .filter(w => w && w.word)
            .slice()
            .sort((a, b) => {
                const ai = Number(a.packIndex) || 0;
                const bi = Number(b.packIndex) || 0;
                if (ai && bi && ai !== bi) return ai - bi;
                if (ai && !bi)             return -1;
                if (!ai && bi)             return 1;
                return (a.addedAt || 0) - (b.addedAt || 0);
            });
    }

    // Every word already handed to a piece, pending or ready. Reserving
    // at prompt time is what makes "the rest of the words" work across
    // runs; deleting a piece releases its words.
    function usedSet(stories) {
        const set = new Set();
        (stories || load()).forEach(s => (s && s.words || []).forEach(w => set.add(norm(w))));
        return set;
    }

    function notebookMap() {
        const m = new Map();
        (window.DB?.loadNotebook?.() || []).forEach(w => {
            if (w && w.word) m.set(norm(w.word), w);
        });
        return m;
    }

    // ─── Batching ────────────────────────────────────────────

    // opts: { count, groupSize, skipUsed }
    function planBatch(opts) {
        const o         = opts || {};
        const count     = Math.max(1, Number(o.count)     || 100);
        const groupSize = Math.max(1, Number(o.groupSize) || 20);
        const used      = o.skipUsed === false ? new Set() : usedSet();
        const pool      = orderedWords()
                            .map(w => String(w.word))
                            .filter(w => !used.has(norm(w)));

        const take   = pool.slice(0, count);
        const groups = [];
        for (let i = 0; i < take.length; i += groupSize) {
            groups.push(take.slice(i, i + groupSize));
        }
        const capped = groups.length > MAX_GROUPS;
        const kept   = capped ? groups.slice(0, MAX_GROUPS) : groups;
        const taken  = kept.reduce((n, g) => n + g.length, 0);

        return {
            groups    : kept,
            taken     : taken,
            poolSize  : pool.length,
            remaining : pool.length - taken,
            capped    : capped
        };
    }

    // Writes one pending piece per group and returns them.
    function createBatch(opts) {
        const plan = planBatch(opts);
        if (!plan.groups.length) return null;

        const arr     = load();
        const batchId = 'b' + Date.now().toString(36);
        const stamp   = Date.now();
        let   seq     = nextSeq(arr);

        const made = plan.groups.map(g => ({
            id        : 'sy' + stamp.toString(36) + '_' + seq,
            seq       : seq++,
            batchId   : batchId,
            status    : 'pending',
            createdAt : stamp,
            filledAt  : 0,
            type      : opts.type   || 'story',
            level     : opts.level  || 'C1',
            length    : Number(opts.length) || 120,
            topic     : opts.topic  || '',
            words     : g.map(norm),
            title     : '',
            sents     : [],
            qs        : [],
            done      : false
        }));

        if (!save(arr.concat(made))) return null;
        return { batchId: batchId, stories: made, plan: plan };
    }

    // ─── Prompt ──────────────────────────────────────────────

    function buildPrompt(stories, opts) {
        const list = (stories || []).filter(Boolean);
        if (!list.length) return '';

        const o    = opts || {};
        const nb   = notebookMap();
        const form = TYPE_LABEL[o.type] || TYPE_LABEL.story;
        const L    = [];

        L.push('You are writing English reading material for an advanced Chinese learner who is studying the target words below in a vocabulary notebook.');
        L.push('');
        L.push('Write ' + list.length + ' separate piece' + (list.length > 1 ? 's' : '') + '. Each piece has its own seq number and its own target words.');
        L.push('');
        const wordsPer = list[0] && (o.length || 0)
                       ? Math.round((o.length || 0) / Math.max(1, list[0].words.length))
                       : 0;
        L.push('FORM      ' + form);
        L.push('LEVEL     CEFR ' + (o.level || 'C1'));
        L.push('LENGTH    about ' + (Number(o.length) || 360) + ' words per piece'
             + (wordsPer ? ' (roughly ' + wordsPer + ' words of prose per target word, '
                         + 'so there is room for the writing to breathe)' : ''));
        if (o.topic) L.push('TOPIC     ' + o.topic);
        L.push('');
        L.push('RULES');
        L.push('1. Use every target word of a piece at least once in that piece. Inflected forms count (plural, past tense, -ing, comparative).');
        L.push('1a. Write ONE continuous piece, not a set of example sentences. Every sentence must follow from the one before it through the same characters, the same situation, and ordinary connective devices: pronouns referring back, time moving forward, cause and effect. A reader must not be able to reorder the sentences without the piece breaking.');
        L.push('1b. Do NOT give each target word its own sentence. Most sentences should carry no target word at all, and some should carry two. The target words have to disappear into the prose.');
        L.push('2. A Chinese gloss in brackets after a word is the sense to use. Do not switch to a rare secondary sense.');
        L.push('3. Give each target word enough context that a reader could infer its meaning without a dictionary.');
        L.push('4. Write the natural, idiomatic English an educated native writer would produce. No textbook filler and no word-list feel.');
        L.push('5. Do not use another piece\u2019s target words unless it is unavoidable.');
        L.push('6. Split each piece into sentences, one object per sentence, in reading order. Keep every sentence under 30 words so it reads aloud well. The split is for audio and study only, so write the piece as prose first and cut it into sentences afterwards.');
        L.push('6a. Add "br": true to the first sentence of each new paragraph. Aim for a paragraph every 4 to 6 sentences.');
        L.push('7. "zh" is a faithful, natural Chinese translation of that one sentence, not a word-for-word gloss.');
        L.push('8. Copy each seq exactly as given. The app matches your reply back to the right piece by seq.');
        if (o.questions) L.push('9. Add 2 comprehension questions per piece, with short answers.');
        L.push('');
        L.push('PIECES');
        list.forEach(s => {
            const words = (s.words || []).map(w => {
                const e  = nb.get(norm(w));
                const cn = e && String(e.meaning || '').trim();
                return cn ? w + ' [' + cn + ']' : w;
            }).join('; ');
            L.push('seq ' + s.seq + ' (' + (s.words || []).length + ' words): ' + words);
        });
        L.push('');
        L.push('OUTPUT');
        L.push('Return only this JSON. No markdown fences, no commentary before or after it.');
        L.push('{"stories":[{"seq":<number>,"title":"<2-6 words>","level":"<CEFR>",'
             + '"sentences":[{"en":"<one sentence>","zh":"<Chinese translation>","br":<true on the first sentence of a paragraph, otherwise omit>}],'
             + '"words_used":[{"word":"<target word exactly as given>","form":"<the form used in the text>"}]'
             + (o.questions ? ',"questions":[{"q":"<question>","a":"<short answer>"}]' : '')
             + '}]}');
        return L.join('\n');
    }

    // ─── Parsing a pasted reply ──────────────────────────────

    // Walks from an opening brace/bracket to its match, ignoring braces
    // inside string literals and escaped quotes. Returns the index of the
    // closing character, or -1.
    function matchEnd(s, start) {
        const close = s[start] === '{' ? '}' : ']';
        let depth   = 0;
        let inStr   = false;
        let esc     = false;
        for (let i = start; i < s.length; i++) {
            const c = s[i];
            if (inStr) {
                if (esc)             esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"')  inStr = false;
                continue;
            }
            if (c === '"') { inStr = true; continue; }
            if (c === '{' || c === '[') depth++;
            else if (c === '}' || c === ']') {
                depth--;
                if (depth === 0) return c === close ? i : -1;
            }
        }
        return -1;
    }

    // Every top-level JSON value in a reply that may also carry prose,
    // markdown fences, or several objects pasted one after another.
    function jsonBlobs(text) {
        const s   = String(text || '').replace(/```+\s*(?:json)?/gi, ' ');
        const out = [];
        let i     = 0;
        while (i < s.length) {
            if (s[i] === '{' || s[i] === '[') {
                const end = matchEnd(s, i);
                if (end > i) { out.push(s.slice(i, end + 1)); i = end + 1; continue; }
            }
            i++;
        }
        return out;
    }

    function splitSentences(text) {
        const t = clean(text);
        if (!t) return [];
        return (t.match(/[^.!?]+[.!?]+["\u201d\u2019)]*|[^.!?]+$/g) || [t])
            .map(x => clean(x))
            .filter(Boolean);
    }

    // Accepts [{en,zh}], ["sentence", ...], or one text blob.
    function normSents(raw) {
        if (!raw) return [];
        if (typeof raw === 'string') return splitSentences(raw).map(en => ({ en: en, zh: '' }));
        if (!Array.isArray(raw))     return [];
        const out = [];
        raw.forEach(item => {
            if (typeof item === 'string') {
                const en = clean(item);
                if (en) out.push({ en: en, zh: '' });
                return;
            }
            if (!item || typeof item !== 'object') return;
            const en = clean(item.en || item.english || item.text || item.sentence);
            const zh = clean(item.zh || item.cn || item.chinese || item.translation);
            // br marks the first sentence of a new paragraph. Absent on
            // everything written before v103, which then renders as one
            // paragraph - the old behaviour, unchanged.
            const br = item.br === true || item.paragraph === true
                    || item.newParagraph === true;
            if (en) out.push(br ? { en: en, zh: zh, br: true } : { en: en, zh: zh });
        });
        return out;
    }

    function normQs(raw) {
        if (!Array.isArray(raw)) return [];
        return raw.map(x => {
            if (typeof x === 'string') return { q: clean(x), a: '' };
            if (!x || typeof x !== 'object') return null;
            return { q: clean(x.q || x.question), a: clean(x.a || x.answer) };
        }).filter(x => x && x.q);
    }

    function parseResponse(text) {
        const found = [];
        const seen  = new Set();

        const push = (o) => {
            if (!o || typeof o !== 'object') return;
            const sents = normSents(o.sentences || o.sents || o.text || o.body);
            if (!sents.length) return;
            const seq = Number(o.seq || o.group || o.piece || o.index) || 0;
            const k   = seq + '|' + norm(sents[0].en).slice(0, 40);
            if (seen.has(k)) return;
            seen.add(k);
            found.push({
                seq   : seq,
                title : clean(o.title || o.heading),
                level : clean(o.level || o.cefr),
                sents : sents,
                qs    : normQs(o.questions || o.qs)
            });
        };

        jsonBlobs(text).forEach(blob => {
            let v;
            try { v = JSON.parse(blob); } catch (e) { return; }
            if (Array.isArray(v))                    v.forEach(push);
            else if (v && Array.isArray(v.stories))  v.stories.forEach(push);
            else if (v && Array.isArray(v.pieces))   v.pieces.forEach(push);
            else                                     push(v);
        });
        return found;
    }

    // Which target words never made it into the text. Single words match
    // through the notebook's inflection matcher, so "proved" counts for
    // "prove"; phrases match as substrings.
    function findGaps(story) {
        const text  = (story.sents || []).map(s => s.en).join(' ');
        const low   = ' ' + norm(text) + ' ';
        const toks  = new Set(norm(text).match(new RegExp(WORD_RE.source, WORD_RE.flags)) || []);
        const gaps  = [];
        (story.words || []).forEach(w => {
            const t = norm(w);
            if (!t) return;
            if (t.indexOf(' ') >= 0) {
                if (low.indexOf(t) < 0) gaps.push(w);
                return;
            }
            if (toks.has(t)) return;
            let hit = false;
            toks.forEach(tok => {
                if (hit) return;
                if (window.DB?.isInflectionOf?.(tok, t)) hit = true;
            });
            if (!hit) gaps.push(w);
        });
        return gaps;
    }

    // Writes a pasted reply into the pending pieces. Matching is by seq;
    // a reply with no usable seq numbers falls back to filling the oldest
    // pending pieces in the order they appear.
    function applyResponse(text) {
        const parsed = parseResponse(text);
        if (!parsed.length) return { filled: 0, unmatched: 0, gaps: [], parsed: 0 };

        const arr     = load();
        const bySeq   = new Map(arr.map(s => [Number(s.seq), s]));
        const pending = arr.filter(s => s && s.status === 'pending')
                           .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));

        let filled    = 0;
        let unmatched = 0;
        const gaps    = [];
        let fallback  = 0;

        parsed.forEach(p => {
            let target = p.seq ? bySeq.get(p.seq) : null;
            if (!target) target = pending[fallback++] || null;
            if (!target) { unmatched++; return; }

            target.title    = p.title || target.title || ('Piece ' + target.seq);
            target.level    = p.level || target.level || '';
            target.sents    = p.sents;
            target.qs       = p.qs;
            target.status   = 'ready';
            target.filledAt = Date.now();
            filled++;

            const miss = findGaps(target);
            if (miss.length) gaps.push({ seq: target.seq, words: miss });
        });

        if (filled) save(arr);
        return { filled: filled, unmatched: unmatched, gaps: gaps, parsed: parsed.length };
    }

    // ─── Audio pack integration ──────────────────────────────

    function readyStories() {
        return load()
            .filter(s => s && s.status === 'ready' && (s.sents || []).length)
            .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    }

    // One wordlist.txt block per finished piece. app.js normalises and
    // de-duplicates these against the vocabulary entries before writing
    // the file, so a sentence shared with a word's example is stored once.
    function speechBlocks() {
        return readyStories().map(s => ({
            index   : PACK_BASE + (Number(s.seq) || 0),
            word    : 'story ' + s.seq + (s.title ? ': ' + s.title : ''),
            entries : (s.sents || []).map(x => x.en).filter(Boolean)
        })).filter(b => b.entries.length);
    }

    function speechList() {
        const out = [];
        readyStories().forEach(s => (s.sents || []).forEach(x => { if (x.en) out.push(x.en); }));
        return out;
    }

    // ─── Cloud publish ───────────────────────────────────────
    //
    // The word list is not a thing to manage by hand. The build is already
    // differential — the generator downloads the previous pack and keys
    // every clip by (text, voice), so publishing the same list twice
    // synthesises nothing, and adding a voice only synthesises that voice.
    // So the app publishes the whole list, every time, and lets the cloud
    // work out the difference. There is no range to set and none to clear.
    //
    // A build range only ever existed to pace a run against the 6-hour
    // runner limit. That is the generator's job (a time budget plus the
    // partial-pack publish), not a switch a person has to remember, so
    // publishing clears any range left over from the old flow.

    // Both keys sit outside every emp_<profile>_ prefix, so neither the
    // token nor the repo can be picked up by the Gist sync snapshot. A
    // repo-scoped token in a synced payload would be a credential leak.
    const K_GH_TOKEN  = 'empro_gh_token';
    const K_GH_REPO   = 'empro_gh_repo';
    const K_GH_PUSHED = 'empro_gh_pushed';
    const LIST_PATH   = 'tools/wordlist.txt';
    const LIST_BRANCH = 'main';

    function ghToken()      { try { return localStorage.getItem(K_GH_TOKEN) || ''; } catch (e) { return ''; } }
    function ghRepo()       { try { return (localStorage.getItem(K_GH_REPO) || '').trim(); } catch (e) { return ''; } }
    function ghConfigured() { return !!(ghToken() && /^[^/\s]+\/[^/\s]+$/.test(ghRepo())); }

    function utf8(text) { return new TextEncoder().encode(String(text || '')); }

    // Base64 in chunks: String.fromCharCode.apply on a 300 KB array blows
    // the argument limit on every engine that matters.
    function b64(bytes) {
        let out = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(out);
    }

    function hex(buf) {
        return Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // Git's own object id: sha1("blob <bytelength>\0" + bytes). Comparing
    // this against the sha the contents API reports tells us whether the
    // remote file already holds these exact bytes, using one request and
    // without downloading the file. Returns '' when SubtleCrypto is absent
    // (an insecure context), and the caller then just publishes.
    async function gitBlobSha(bytes) {
        if (!window.crypto?.subtle) return '';
        const head = utf8('blob ' + bytes.length + '\0');
        const all  = new Uint8Array(head.length + bytes.length);
        all.set(head, 0);
        all.set(bytes, head.length);
        try { return hex(await crypto.subtle.digest('SHA-1', all)); }
        catch (e) { return ''; }
    }

    function ghHeaders(extra) {
        return Object.assign({
            'Authorization' : 'Bearer ' + ghToken(),
            'Accept'        : 'application/vnd.github+json'
        }, extra || {});
    }

    function ghUrl() {
        return 'https://api.github.com/repos/' + ghRepo() + '/contents/'
             + LIST_PATH + '?ref=' + LIST_BRANCH;
    }

    // Current remote state of the word list: { sha } , or null when the
    // file does not exist yet. Throws on auth and network failures so the
    // caller can report something specific.
    async function ghHead() {
        const resp = await fetch(ghUrl(), { headers: ghHeaders() });
        if (resp.status === 404) return null;
        if (resp.status === 401 || resp.status === 403) {
            throw new Error('GitHub rejected the token (' + resp.status
                          + '). It needs write access to Contents on ' + ghRepo() + '.');
        }
        if (!resp.ok) throw new Error('GitHub read failed: ' + resp.status);
        const j = await resp.json();
        return { sha: j.sha || '' };
    }

    async function ghPut(bytes, sha, message) {
        const body = { message : message, content : b64(bytes), branch : LIST_BRANCH };
        if (sha) body.sha = sha;
        const resp = await fetch('https://api.github.com/repos/' + ghRepo()
                                 + '/contents/' + LIST_PATH, {
            method  : 'PUT',
            headers : ghHeaders({ 'Content-Type' : 'application/json' }),
            body    : JSON.stringify(body)
        });
        if (!resp.ok) {
            let detail = '';
            try { detail = (await resp.json()).message || ''; } catch (e) {}
            throw new Error('GitHub write failed: ' + resp.status
                          + (detail ? ' \u2014 ' + detail : ''));
        }
        return resp.json();
    }

    // Publishes the word list and lets the push event start the build.
    // Returns { state } where state is one of: 'same' (remote already has
    // these bytes, nothing pushed and nothing built), 'pushed', 'download'
    // (no repo configured, the file was downloaded instead), or 'error'.
    async function publishWordList(opts) {
        const quiet = opts && opts.quiet;
        const say   = (m, ms) => { if (!quiet) toast(m, ms); };

        // Any range left over from the old flow would silently narrow the
        // build, so it goes before the text is built.
        if ((window.DB?.getPref?.('pack_range', '') || '').trim()) {
            window.App?.setPackRange?.('');
        }

        const text = window.App?.buildWordListText?.();
        if (!text) {
            say('Nothing to publish \u2014 add words to the notebook first.');
            return { state : 'error' };
        }

        if (!ghConfigured()) {
            if (!quiet) {
                window.App?.exportWordList?.();
                toast('Downloaded wordlist.txt. Fill in the repo and token above '
                    + 'to let the app commit it for you.', 6000);
            }
            return { state : 'download' };
        }

        const bytes = utf8(text);
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        setBusy(true);
        try {
            const local  = await gitBlobSha(bytes);
            const remote = await ghHead();
            if (remote && local && remote.sha === local) {
                setPushed(stamp, 'same');
                say('The cloud word list already matches this device \u2014 nothing pushed, '
                  + 'nothing to build.', 5000);
                return { state : 'same' };
            }
            const words   = (window.DB?.loadNotebook?.() || []).length;
            const pieces  = readyStories().length;
            await ghPut(bytes, remote ? remote.sha : '',
                'audio pack: word list from EMPro (' + words + ' words, '
                + pieces + ' piece' + (pieces === 1 ? '' : 's') + ')');
            setPushed(stamp, 'pushed');
            say('Committed ' + LIST_PATH + ' \u2014 the audio pack build starts on the push. '
              + 'It only synthesises clips the pack does not already have.', 7000);
            return { state : 'pushed' };
        } catch (e) {
            console.error('[stories] publish failed:', e && e.message);
            say('Could not publish: ' + (e && e.message || 'network error')
              + ' \u2014 use \u201cDownload only\u201d and commit by hand.', 8000);
            return { state : 'error' };
        } finally {
            setBusy(false);
            renderAudioLine();
        }
    }

    function setPushed(stamp, state) {
        try { localStorage.setItem(K_GH_PUSHED, state + '@' + stamp); } catch (e) {}
    }
    function lastPushed() {
        try { return localStorage.getItem(K_GH_PUSHED) || ''; } catch (e) { return ''; }
    }

    function setBusy(on) {
        const btn = document.getElementById('sy-publish');
        if (!btn) return;
        btn.disabled    = on;
        btn.textContent = on ? 'Publishing\u2026' : '\u2601 Publish word list';
    }

    function downloadOnly() {
        if ((window.DB?.getPref?.('pack_range', '') || '').trim()) {
            window.App?.setPackRange?.('');
        }
        window.App?.exportWordList?.();
        renderAudioLine();
    }

    // ─── Target-word highlighting ────────────────────────────

    function mergeRanges(ranges) {
        const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || b[1] - a[1]);
        const out    = [];
        sorted.forEach(r => {
            const last = out[out.length - 1];
            if (last && r[0] < last[1]) return;   // overlapped by a longer hit
            out.push(r);
        });
        return out;
    }

    // Token pattern for single-word targets. The Unicode form also catches
    // digits and accented letters, so "COVID-19", "3D", and "naive" with a
    // diaeresis all match. It is built with new RegExp inside a try so an
    // engine without \p{...} support (an old Android WebView) falls back to
    // ASCII instead of failing to parse this whole file.
    const WORD_RE = (function () {
        try { return new RegExp('[\\p{L}\\p{N}][\\p{L}\\p{N}\'\u2019-]*', 'gu'); }
        catch (e) { return /[A-Za-z0-9][A-Za-z0-9'\u2019-]*/g; }
    })();

    // Returns escaped HTML with every target word wrapped in a <mark>.
    function highlight(sentence, targets) {
        const text = String(sentence || '');
        if (!text) return '';
        const list = (targets || []).map(norm).filter(Boolean);
        if (!list.length) return esc(text);

        const low    = text.toLowerCase();
        const ranges = [];

        // Phrases first, longest first, so "take on board" beats "board".
        list.filter(t => t.indexOf(' ') >= 0)
            .sort((a, b) => b.length - a.length)
            .forEach(t => {
                let from = 0;
                let at;
                while ((at = low.indexOf(t, from)) >= 0) {
                    ranges.push([at, at + t.length, t]);
                    from = at + t.length;
                }
            });

        const singles = list.filter(t => t.indexOf(' ') < 0);
        if (singles.length) {
            const re = new RegExp(WORD_RE.source, WORD_RE.flags);
            let m;
            while ((m = re.exec(text)) !== null) {
                const tok = m[0].toLowerCase().replace(/['\u2019]s$/, '');
                let hit   = null;
                for (const t of singles) {
                    if (t === tok || window.DB?.isInflectionOf?.(tok, t)) { hit = t; break; }
                }
                if (hit) ranges.push([m.index, m.index + m[0].length, hit]);
            }
        }

        const merged = mergeRanges(ranges);
        if (!merged.length) return esc(text);

        let html = '';
        let at   = 0;
        merged.forEach(r => {
            html += esc(text.slice(at, r[0]));
            html += '<mark class="sy-hit" data-w="' + escA(r[2]) + '">'
                  + esc(text.slice(r[0], r[1])) + '</mark>';
            at = r[1];
        });
        html += esc(text.slice(at));
        return html;
    }

    // ─── UI: generator panel ─────────────────────────────────

    // Words of prose per target word. Below about 8 there is no room for a
    // narrative between the target words, and the model has no choice but to
    // write one sentence per word - which is what made early pieces read like
    // a list of examples rather than a story. 18 leaves room to breathe.
    const DENSITY_COMFORTABLE = 18;
    const DENSITY_TIGHT       = 13;
    const DENSITY_TOO_DENSE   = 8;

    function suggestedLength(groupSize) {
        const n = Math.round(groupSize * DENSITY_COMFORTABLE / 20) * 20;
        return Math.max(80, Math.min(900, n));
    }

    function densityNote(groupSize, length) {
        const per = length / Math.max(1, groupSize);
        if (per < DENSITY_TOO_DENSE) {
            return { cls : 'sy-warn', text : 'one target word every '
                   + per.toFixed(1) + ' words \u2014 too dense for prose, '
                   + 'expect a list of examples. Try '
                   + suggestedLength(groupSize) + '.' };
        }
        if (per < DENSITY_TIGHT) {
            return { cls : 'sy-dim', text : 'one target word every '
                   + per.toFixed(1) + ' words \u2014 tight. '
                   + suggestedLength(groupSize) + ' reads better.' };
        }
        return { cls : 'sy-dim', text : 'one target word every '
               + per.toFixed(1) + ' words \u2014 comfortable.' };
    }

    function readOpts() {
        return {
            count     : Math.max(1, parseInt(document.getElementById('sy-count')?.value, 10) || 100),
            groupSize : Math.max(1, parseInt(document.getElementById('sy-group')?.value, 10) || 20),
            type      : document.getElementById('sy-type')?.value  || 'story',
            level     : document.getElementById('sy-level')?.value || 'C1',
            length    : parseInt(document.getElementById('sy-len')?.value, 10) || 0,
            topic     : (document.getElementById('sy-topic')?.value || '').trim(),
            skipUsed  : document.getElementById('sy-skip')?.checked !== false,
            questions : document.getElementById('sy-qs')?.checked === true
        };
    }

    function saveOpts(o) {
        setPref('count', o.count);
        setPref('group', o.groupSize);
        setPref('type',  o.type);
        setPref('level', o.level);
        setPref('len',   o.length);
        setPref('topic', o.topic);
        setPref('skip',  o.skipUsed  ? '1' : '0');
        setPref('qs',    o.questions ? '1' : '0');
    }

    // The voice that reads sentences. Pinned deliberately, because the
    // generator's fallback is "the first selected word voice" and that moves
    // whenever the word voice selection changes, re-synthesising every
    // sentence in the pack.
    function renderSentenceVoice() {
        const sel = document.getElementById('sy-svoice');
        if (!sel) return;
        const list = window.App?.packVoiceList || ['nova'];
        const cur  = window.App?.getPackSentenceVoice?.() || 'nova';
        sel.innerHTML = list.map(v =>
            '<option value="' + escA(v) + '"' + (v === cur ? ' selected' : '') + '>'
            + esc(v.charAt(0).toUpperCase() + v.slice(1)) + '</option>').join('');
    }

    function hydrateCloud() {
        const r = document.getElementById('sy-repo');
        const t = document.getElementById('sy-token');
        if (r) r.value = ghRepo();
        if (t) t.value = ghToken() ? '\u2022'.repeat(12) : '';
        const auto = document.getElementById('sy-auto');
        if (auto) auto.checked = pref('auto', '1') !== '0';
    }

    function saveCloud() {
        const r = document.getElementById('sy-repo');
        const t = document.getElementById('sy-token');
        try {
            if (r) localStorage.setItem(K_GH_REPO, (r.value || '').trim());
            // A masked field means "unchanged" - never overwrite a real
            // token with the dots we drew over it.
            const v = (t && t.value || '').trim();
            if (v && v.indexOf('\u2022') < 0) localStorage.setItem(K_GH_TOKEN, v);
            if (t && !v) localStorage.removeItem(K_GH_TOKEN);
        } catch (e) {}
        renderAudioLine();
    }

    function hydrateOpts() {
        const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
        set('sy-count', pref('count', '100'));
        set('sy-group', pref('group', '20'));
        set('sy-type',  pref('type',  'story'));
        set('sy-level', pref('level', 'C1'));
        const gs = parseInt(pref('group', '20'), 10) || 20;
        set('sy-len',   pref('len', String(suggestedLength(gs))));
        set('sy-topic', pref('topic', ''));
        const skip = document.getElementById('sy-skip');
        if (skip) skip.checked = pref('skip', '1') !== '0';
        const qs = document.getElementById('sy-qs');
        if (qs) qs.checked = pref('qs', '0') === '1';
    }

    function renderPreview() {
        const el = document.getElementById('sy-preview');
        if (!el) return;
        const o    = readOpts();
        const plan = planBatch(o);
        const all  = orderedWords().length;

        if (!all) {
            el.innerHTML = '<span class="sy-dim">Add words to your notebook first \u2014 '
                         + 'they are the raw material for these pieces.</span>';
            return;
        }
        if (!plan.groups.length) {
            el.innerHTML = '<span class="sy-dim">Every word is already in a piece. '
                         + 'Untick \u201cskip used\u201d to write about them again, '
                         + 'or delete a piece to release its words.</span>';
            return;
        }
        const sizes = plan.groups.map(g => g.length).join(' + ');
        const dens  = densityNote(o.groupSize, o.length || suggestedLength(o.groupSize));
        el.innerHTML = '<strong>' + plan.groups.length + ' piece'
                     + (plan.groups.length > 1 ? 's' : '') + '</strong> \u00b7 '
                     + plan.taken + ' words (' + sizes + ') \u00b7 '
                     + plan.remaining + ' unused word' + (plan.remaining === 1 ? '' : 's')
                     + ' left after this run'
                     + (plan.capped ? ' \u00b7 <span class="sy-warn">capped at ' + MAX_GROUPS
                                    + ' pieces per run</span>' : '')
                     + '<br><span class="' + dens.cls + '">' + esc(dens.text) + '</span>';
    }

    function pendingStories() {
        return load()
            .filter(s => s && s.status === 'pending')
            .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    }

    function copyPrompt(stories, opts, label) {
        const text = buildPrompt(stories, opts);
        if (!text) return;
        const done = () => toast(label || ('Prompt for ' + stories.length
                    + ' piece(s) copied. Paste it into Claude, then use \u201cPaste back\u201d.'), 5000);
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => showPromptFallback(text));
        } else {
            showPromptFallback(text);
        }
    }

    // Clipboard writes fail on an insecure origin or without a user
    // gesture; show the text so it can still be copied by hand.
    function showPromptFallback(text) {
        const box = modal('sy-prompt-modal', 'Copy this prompt',
            '<p class="settings-hint">Select all and copy, then paste it into Claude.</p>'
          + '<textarea id="sy-prompt-text" class="mw-import-textarea" rows="12"></textarea>');
        const ta = document.getElementById('sy-prompt-text');
        if (ta) { ta.value = text; ta.focus(); ta.select(); }
        box.classList.add('open');
    }

    function handleMake() {
        const o = readOpts();
        saveOpts(o);
        const plan = planBatch(o);
        if (!plan.groups.length) { renderPreview(); return; }

        const batch = createBatch(o);
        if (!batch) { toast('Could not reserve those words.'); return; }
        copyPrompt(batch.stories, o,
            'Reserved ' + batch.plan.taken + ' words in ' + batch.stories.length
          + ' piece(s) and copied the prompt. Paste it into Claude, then come '
          + 'back and use \u201cPaste back\u201d.');
        showScreen('library');
        renderAll();
    }

    function handleCopyPending() {
        const list = pendingStories();
        if (!list.length) { toast('No pieces are waiting for text.'); return; }
        const o = readOpts();
        copyPrompt(list, { type: list[0].type, level: list[0].level, length: list[0].length,
                           topic: list[0].topic, questions: o.questions },
            'Prompt for ' + list.length + ' waiting piece(s) copied.');
    }

    // ─── UI: paste back ──────────────────────────────────────

    function modal(id, title, bodyHtml) {
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('div');
            el.id        = id;
            el.className = 'modal-overlay';
            document.body.appendChild(el);
        }
        el.innerHTML = '<div class="modal-card"><div class="modal-header"><h2>' + esc(title)
                     + '</h2><button class="modal-close" data-sy-close="' + escA(id)
                     + '">&times;</button></div><div class="modal-body">' + bodyHtml + '</div></div>';
        el.querySelector('[data-sy-close]')?.addEventListener('click', () => el.classList.remove('open'));
        el.addEventListener('click', (e) => { if (e.target === el) el.classList.remove('open'); });
        return el;
    }

    function openPasteModal() {
        const waiting = pendingStories();
        const el = modal('sy-paste-modal', 'Paste the AI reply',
            '<p class="settings-hint">Paste the whole reply. Pieces are matched by their seq number'
          + (waiting.length ? ' \u2014 ' + waiting.length + ' piece(s) waiting: seq '
                              + waiting.map(s => s.seq).join(', ') : '')
          + '. Markdown fences and extra commentary are fine.</p>'
          + '<textarea id="sy-paste-input" class="mw-import-textarea" rows="12" '
          + 'placeholder="{&quot;stories&quot;:[ ... ]}"></textarea>'
          + '<button class="wl-btn-primary" id="sy-paste-apply" style="width:100%;margin-top:10px">'
          + 'Add to my materials</button>');

        document.getElementById('sy-paste-apply')?.addEventListener('click', () => {
            const text = (document.getElementById('sy-paste-input')?.value || '').trim();
            if (!text) { toast('Paste the reply first.'); return; }

            const res = applyResponse(text);
            if (!res.filled) {
                toast(res.parsed
                    ? 'Found ' + res.parsed + ' piece(s) but none matched a waiting seq number.'
                    : 'No JSON found in that text. Copy the whole reply, including the braces.', 6000);
                return;
            }
            let msg = 'Added ' + res.filled + ' piece(s).';
            if (res.unmatched) msg += ' ' + res.unmatched + ' had no matching piece.';
            if (res.gaps.length) {
                msg += ' Missing target words in seq '
                     + res.gaps.map(g => g.seq + ' (' + g.words.join(', ') + ')').join('; ') + '.';
            }
            toast(msg, res.gaps.length ? 8000 : 4000);
            el.classList.remove('open');
            renderAll();

            // New sentences exist, so the pack is now behind. Publishing is
            // safe to do unattended: the build is differential, so a run
            // with nothing new to say costs nothing.
            if (ghConfigured() && pref('auto', '1') !== '0') {
                publishWordList({ quiet : false });
            }
        });
        el.classList.add('open');
    }

    // ─── UI: material list ───────────────────────────────────

    function wordCount(s) {
        return (s.sents || []).reduce((n, x) => n + (x.en || '').split(/\s+/).filter(Boolean).length, 0);
    }

    function renderList() {
        const box = document.getElementById('sy-list');
        if (!box) return;
        const arr = load().sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));

        if (!arr.length) {
            box.innerHTML = '<div class="sy-empty">Nothing here yet.<br>'
                          + '\u201cNew pieces\u201d turns the words in your notebook into '
                          + 'short readings.</div>';
            return;
        }

        box.innerHTML = arr.map(s => {
            const ready = s.status === 'ready';
            const chips = (s.words || []).slice(0, 8).map(w =>
                '<span class="sy-chip">' + esc(w) + '</span>').join('')
                + ((s.words || []).length > 8
                    ? '<span class="sy-chip sy-chip-more">+' + ((s.words || []).length - 8) + '</span>' : '');
            return '<div class="sy-card' + (s.done ? ' sy-card-done' : '') + '">'
                 + '<div class="sy-card-head">'
                 + '<span class="sy-seq">#' + s.seq + '</span>'
                 + '<span class="sy-title">' + esc(ready ? (s.title || 'Untitled') : 'Waiting for text') + '</span>'
                 + '<span class="sy-pill ' + (ready ? 'sy-pill-ready' : 'sy-pill-wait') + '">'
                 + (ready ? (s.level || 'ready') : 'pending') + '</span>'
                 + '</div>'
                 + '<div class="sy-chips">' + chips + '</div>'
                 + '<div class="sy-card-foot">'
                 + (ready
                     ? '<span class="sy-dim">' + (s.sents || []).length + ' sentences \u00b7 '
                       + wordCount(s) + ' words</span>'
                       + '<button class="wl-btn-small sy-act" data-act="read" data-id="' + escA(s.id) + '">Read</button>'
                       + '<button class="wl-btn-small sy-act" data-act="done" data-id="' + escA(s.id) + '">'
                       + (s.done ? '\u21ba Reopen' : '\u2713 Done') + '</button>'
                     : '<span class="sy-dim">' + (s.words || []).length + ' words reserved</span>'
                       + '<button class="wl-btn-small sy-act" data-act="copy" data-id="' + escA(s.id) + '">Copy prompt</button>')
                 + '<button class="wl-btn-small sy-act sy-danger" data-act="del" data-id="' + escA(s.id) + '">Delete</button>'
                 + '</div></div>';
        }).join('');
    }

    function renderAudioLine() {
        const el = document.getElementById('sy-audio-line');
        if (!el) return;
        const words = (window.DB?.loadNotebook?.() || []).length;
        const ready = readyStories().length;
        const sents = speechList().length;
        const last  = lastPushed();
        const state = ghConfigured()
            ? (last.indexOf('same@') === 0
                ? 'cloud in sync (' + last.slice(5) + ')'
                : last.indexOf('pushed@') === 0
                    ? 'last published ' + last.slice(7)
                    : 'never published from this device')
            : 'no repo set \u2014 publishing falls back to a download';
        el.innerHTML = esc(words + ' word(s) \u00b7 ' + ready + ' finished piece(s) \u00b7 '
                         + sents + ' sentence(s)')
                     + ' \u00b7 <span class="sy-dim">' + esc(state) + '</span>';
    }

    function renderLibHead() {
        const el = document.getElementById('sy-lib-count');
        if (!el) return;
        const all   = load();
        const ready = all.filter(x => x.status === 'ready');
        const done  = ready.filter(x => x.done).length;
        el.innerHTML = all.length
            ? '<strong>' + ready.length + '</strong> piece'
              + (ready.length === 1 ? '' : 's') + ' to read'
              + (done ? ' \u00b7 <span class="sy-dim">' + done + ' done</span>' : '')
            : '<span class="sy-dim">No material yet</span>';
    }

    // The loop is: copy a prompt, leave for the AI, come back and paste. That
    // return trip often happens in a new session, so the way to finish it has
    // to be on the library screen, not buried in the generator.
    function renderPending() {
        const el = document.getElementById('sy-pending');
        if (!el) return;
        const n = pendingStories().length;
        el.classList.toggle('sy-hidden', !n);
        if (!n) return;
        el.innerHTML = '<span class="sy-pending-text">' + n + ' piece'
                     + (n === 1 ? '' : 's') + ' waiting for text</span>'
                     + '<button class="wl-btn-small" id="sy-pending-copy">Copy prompt</button>'
                     + '<button class="wl-btn-primary sy-pending-paste" id="sy-pending-paste">'
                     + '\u{1F4E5} Paste back</button>';
    }

    function renderAll() {
        renderPreview();
        renderList();
        renderAudioLine();
        renderLibHead();
        renderPending();
        const btn = document.getElementById('sy-copy-pending');
        if (btn) {
            const n = pendingStories().length;
            btn.style.display = n ? '' : 'none';
            btn.textContent   = 'Copy prompt for ' + n + ' waiting';
        }
    }

    // ─── UI: reader ──────────────────────────────────────────

    // ─── Screens ─────────────────────────────────────────────
    //
    // The tab holds three screens and shows one at a time: the library, the
    // generator, and the reader. The library is what gets opened daily, so it
    // is the default and carries nothing but the material. Generating is
    // occasional and cloud setup is a one-time thing, so both sit behind a
    // button rather than in front of the content.
    const SCREENS = { library : 'sy-library', gen : 'sy-gen', read : 'sy-read' };

    function showScreen(name) {
        Object.keys(SCREENS).forEach(k => {
            document.getElementById(SCREENS[k])?.classList.toggle('sy-hidden', k !== name);
        });
        if (name !== 'read') stopPlay();
        scrollTop();
    }

    function openReader(id) {
        const s = byId(id);
        if (!s) return;
        openId = id;
        stopPlay();

        const nb    = notebookMap();
        const words = (s.words || []);
        const prose = pref('view', 'prose') !== 'rows';
        const rows  = prose ? renderProse(s, words) : renderRows(s, words);

        const qs = (s.qs || []).length
            ? '<div class="sy-qs"><h4 class="sy-h4">Check yourself</h4>'
              + s.qs.map((q, i) =>
                  '<div class="sy-q"><div class="sy-q-text">' + (i + 1) + '. ' + esc(q.q) + '</div>'
                + (q.a ? '<div class="sy-a" data-a="' + i + '">Show answer</div>'
                       + '<div class="sy-a-text" id="sy-a-' + i + '" hidden>' + esc(q.a) + '</div>' : '')
                + '</div>').join('') + '</div>'
            : '';

        const glossary = words.map(w => {
            const e = nb.get(norm(w));
            return '<div class="sy-gloss"><span class="sy-gw">' + esc(w) + '</span>'
                 + (e && e.phonetic ? '<span class="sy-gp">' + esc(e.phonetic) + '</span>' : '')
                 + '<span class="sy-gm">' + esc((e && e.meaning) || '\u2014') + '</span></div>';
        }).join('');

        const body = document.getElementById('sy-read-body');
        if (body) {
            body.innerHTML =
                '<div class="sy-read-head"><h3 class="sy-read-title">' + esc(s.title || 'Piece ' + s.seq) + '</h3>'
              + '<div class="sy-read-meta">#' + s.seq + (s.level ? ' \u00b7 ' + esc(s.level) : '')
              + ' \u00b7 ' + (s.sents || []).length + ' sentences \u00b7 ' + wordCount(s) + ' words</div></div>'
              + '<div class="sy-read-tools">'
              + '<button class="wl-btn-small" id="sy-play-all">\u25b6 Play all</button>'
              + '<button class="wl-btn-small" id="sy-stop">\u25a0 Stop</button>'
              + '<button class="wl-btn-small" id="sy-toggle-zh">\u4e2d Chinese</button>'
              + '<button class="wl-btn-small" id="sy-toggle-view">'
              + (prose ? '\u2261 Sentence by sentence' : '\u00b6 Read as prose') + '</button>'
              + '</div>'
              + '<div class="sy-sents' + (prose ? ' sy-prose' : '') + '" id="sy-sents">'
              + rows + '</div>'
              + qs
              + '<div class="sy-glossary"><h4 class="sy-h4">Target words</h4>' + glossary + '</div>';
        }

        showScreen('read');
        applyZhVisibility();
    }

    // Prose view. The piece reads as continuous paragraphs, which is what a
    // story is, while every sentence stays an addressable unit: each one is
    // its own inline span carrying data-i, so tapping still plays that
    // sentence and Play all still highlights its way through. Sentences are
    // the audio pack's unit and cannot stop being separate underneath - but
    // they no longer have to LOOK separate, which was the whole complaint.
    function renderProse(s, words) {
        const sents = s.sents || [];
        const paras = [];
        let cur     = [];
        sents.forEach((x, i) => {
            if (x.br && cur.length) { paras.push(cur); cur = []; }
            cur.push({ x : x, i : i });
        });
        if (cur.length) paras.push(cur);

        return paras.map(para =>
            '<p class="sy-para">'
          + para.map(o => '<span class="sy-s" data-i="' + o.i + '">'
                        + highlight(o.x.en, words) + '</span>').join(' ')
          + '</p>'
          + '<p class="sy-zh-block">'
          + para.map(o => esc(o.x.zh || '')).filter(Boolean).join('') + '</p>'
        ).join('');
    }

    // Sentence-by-sentence view: one row each, English above its own Chinese,
    // with a play button. Better for study and for checking a translation,
    // worse for reading, which is why it is no longer the default.
    function renderRows(s, words) {
        return (s.sents || []).map((x, i) =>
            '<div class="sy-sent" data-i="' + i + '">'
          + '<button class="sy-play" data-i="' + i + '" title="Read this sentence">\u25b6</button>'
          + '<div class="sy-sent-body"><div class="sy-en">' + highlight(x.en, words) + '</div>'
          + (x.zh ? '<div class="sy-zh">' + esc(x.zh) + '</div>' : '')
          + '</div></div>').join('');
    }

    function closeReader() {
        stopPlay();
        openId = null;
        showScreen('library');
        renderAll();
    }

    function applyZhVisibility() {
        const on = pref('zh', '1') !== '0';
        document.getElementById('sy-sents')?.classList.toggle('sy-hide-zh', !on);
        // In prose view the translation is a paragraph of its own, so it is
        // hidden by the same class through a different selector (see the CSS).
        const btn = document.getElementById('sy-toggle-zh');
        if (btn) btn.classList.toggle('active', on);
    }

    function speakSentence(i) {
        const s = byId(openId);
        const x = s && (s.sents || [])[i];
        if (!x) return;
        markPlaying(i);
        window.App?.speak?.(x.en, null, () => markPlaying(-1));
    }

    // Keeping the spoken line on screen is a nicety, not a requirement:
    // some Android WebViews reject the options-object form of these calls
    // and older ones lack scrollIntoView entirely. A throw here would have
    // stopped sequential playback dead, so both calls are best-effort.
    function scrollRowIntoView(i) {
        const row = document.querySelector('#sy-sents [data-i="' + i + '"]:not(button)');
        if (!row || typeof row.scrollIntoView !== 'function') return;
        try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        catch (e) { try { row.scrollIntoView(); } catch (e2) { /* give up quietly */ } }
    }

    function scrollTop() {
        try { window.scrollTo({ top: 0, behavior: 'smooth' }); }
        catch (e) { try { window.scrollTo(0, 0); } catch (e2) { /* give up quietly */ } }
    }

    // Both views tag their sentence containers with data-i, so one selector
    // covers a row and an inline span alike.
    function markPlaying(i) {
        document.querySelectorAll('#sy-sents [data-i]').forEach(el => {
            if (el.tagName === 'BUTTON') return;      // the row's play button
            el.classList.toggle('sy-playing', Number(el.dataset.i) === i);
        });
    }

    function playAll() {
        const s = byId(openId);
        if (!s || !(s.sents || []).length) return;
        stopPlay();
        playStop  = false;
        playToken = window.App?.beginSession?.('stories-read') || 'stories-read';

        const step = (i) => {
            if (playStop || i >= s.sents.length) { stopPlay(); return; }
            markPlaying(i);
            scrollRowIntoView(i);
            // Screen off / tab hidden: only pack clips can sound - the
            // neural fallback's fresh Audio is refused by the autoplay
            // policy and speechSynthesis is suspended on lock. Play the
            // pack hits and skip the misses, exactly like the My Words
            // auto-play queue; the full chain resumes when visible.
            if (document.hidden && window.TTSPack?.playWord) {
                window.TTSPack.playWord(s.sents[i].en, null, () => {
                    if (playStop) return;
                    // Silence, not a timer: the element must keep
                    // sounding or the OS drops the media session.
                    if (window.TTSPack.playSilence) {
                        window.TTSPack.playSilence(350, () => {
                            if (!playStop) step(i + 1);
                        });
                    } else {
                        setTimeout(() => step(i + 1), 350);
                    }
                }).then(hit => { if (!hit && !playStop) step(i + 1); });
                return;
            }
            window.App?.speak?.(s.sents[i].en, null, () => {
                if (playStop) return;
                setTimeout(() => step(i + 1), 350);
            });
        };
        step(0);
    }

    function stopPlay() {
        playStop = true;
        try { window.App?.stopSpeak?.(); } catch (e) {}
        if (playToken) { window.App?.endSession?.(playToken); playToken = null; }
        markPlaying(-1);
    }

    // ─── Events ──────────────────────────────────────────────

    function bind() {
        ['sy-count', 'sy-group', 'sy-type', 'sy-level', 'sy-len', 'sy-topic', 'sy-skip']
            .forEach(id => {
                const el = document.getElementById(id);
                el?.addEventListener('change', () => { saveOpts(readOpts()); renderPreview(); });
                el?.addEventListener('input',  renderPreview);
            });
        // Changing the words-per-piece moves the length that suits it, unless
        // the length was set by hand. Leaving a fixed length behind is what
        // produced pieces with a target word every six words.
        document.getElementById('sy-group')?.addEventListener('change', () => {
            const gs  = parseInt(document.getElementById('sy-group')?.value, 10) || 20;
            const len = document.getElementById('sy-len');
            if (len && !len.dataset.touched) {
                len.value = suggestedLength(gs);
                saveOpts(readOpts());
                renderPreview();
            }
        });
        document.getElementById('sy-len')?.addEventListener('input', (e) => {
            e.target.dataset.touched = '1';
        });
        document.getElementById('sy-qs')?.addEventListener('change', () => saveOpts(readOpts()));

        document.getElementById('sy-new')?.addEventListener('click', () => {
            showScreen('gen');
            renderPreview();
        });
        document.getElementById('sy-gen-back')?.addEventListener('click', () => {
            showScreen('library');
            renderAll();
        });
        document.getElementById('sy-pending')?.addEventListener('click', (e) => {
            if (e.target.closest('#sy-pending-paste')) { openPasteModal(); return; }
            if (e.target.closest('#sy-pending-copy'))  { handleCopyPending(); }
        });
        document.getElementById('sy-make')?.addEventListener('click', handleMake);
        document.getElementById('sy-copy-pending')?.addEventListener('click', handleCopyPending);
        document.getElementById('sy-paste')?.addEventListener('click', openPasteModal);
        document.getElementById('sy-svoice')?.addEventListener('change', (e) => {
            const v = window.App?.setPackSentenceVoice?.(e.target.value);
            toast('Sentences will be read by ' + (v || 'nova')
                + '. Clips already built in another voice stay in the pack \u2014 '
                + 'a build with \u201cprune voices\u201d on reclaims that space.', 7000);
        });
        document.getElementById('sy-publish')?.addEventListener('click', () => publishWordList());
        document.getElementById('sy-download')?.addEventListener('click', downloadOnly);
        ['sy-repo', 'sy-token'].forEach(id =>
            document.getElementById(id)?.addEventListener('change', saveCloud));
        document.getElementById('sy-auto')?.addEventListener('change', () => {
            setPref('auto', document.getElementById('sy-auto')?.checked ? '1' : '0');
        });

        // Material list actions
        document.getElementById('sy-list')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.sy-act');
            if (!btn) return;
            const id = btn.dataset.id;
            const s  = byId(id);
            if (!s) return;

            if (btn.dataset.act === 'read') { openReader(id); return; }
            if (btn.dataset.act === 'copy') {
                copyPrompt([s], { type: s.type, level: s.level, length: s.length,
                                  topic: s.topic, questions: pref('qs', '0') === '1' },
                    'Prompt for piece #' + s.seq + ' copied.');
                return;
            }
            if (btn.dataset.act === 'done') {
                const arr = load();
                const row = arr.find(x => x.id === id);
                if (row) { row.done = !row.done; save(arr); renderList(); }
                return;
            }
            if (btn.dataset.act === 'del') {
                const n = (s.words || []).length;
                if (!confirm('Delete piece #' + s.seq + '? Its ' + n
                           + ' word(s) become available again.')) return;
                save(load().filter(x => x.id !== id));
                toast('Deleted piece #' + s.seq + ' \u2014 ' + n + ' word(s) released.');
                renderAll();
            }
        });

        // Reader
        document.getElementById('sy-back')?.addEventListener('click', closeReader);
        document.getElementById('sy-read')?.addEventListener('click', (e) => {
            if (e.target.closest('#sy-play-all'))  { playAll(); return; }
            if (e.target.closest('#sy-stop'))      { stopPlay(); return; }
            if (e.target.closest('#sy-toggle-zh')) {
                setPref('zh', pref('zh', '1') !== '0' ? '0' : '1');
                applyZhVisibility();
                return;
            }
            if (e.target.closest('#sy-toggle-view')) {
                setPref('view', pref('view', 'prose') === 'rows' ? 'prose' : 'rows');
                const at = openId;
                openReader(at);
                return;
            }
            const ans = e.target.closest('.sy-a');
            if (ans) {
                const t = document.getElementById('sy-a-' + ans.dataset.a);
                if (t) t.hidden = !t.hidden;
                return;
            }
            const hit = e.target.closest('.sy-hit');
            if (hit) {
                const w = hit.dataset.w || hit.textContent;
                const e2 = notebookMap().get(norm(w));
                window.App?.speak?.(hit.textContent);
                if (e2 && e2.meaning) toast(w + ' \u2014 ' + e2.meaning);
                return;
            }
            const play = e.target.closest('.sy-play');
            if (play) { speakSentence(Number(play.dataset.i)); return; }
            const span = e.target.closest('.sy-s');
            if (span) { speakSentence(Number(span.dataset.i)); return; }
            const row = e.target.closest('.sy-sent');
            if (row) speakSentence(Number(row.dataset.i));
        });
    }

    function init() {
        if (!document.getElementById('view-stories')) return;
        hydrateOpts();
        hydrateCloud();
        renderSentenceVoice();
        bind();
        renderAll();
        showScreen('library');
    }

    return {
        init          : init,
        PACK_BASE     : PACK_BASE,
        speechBlocks  : speechBlocks,
        speechList    : speechList,
        publishWordList : publishWordList,
        ghConfigured    : ghConfigured,
        load          : load,
        save          : save,
        planBatch     : planBatch,
        createBatch   : createBatch,
        buildPrompt   : buildPrompt,
        parseResponse : parseResponse,
        applyResponse : applyResponse,
        findGaps      : findGaps,
        highlight     : highlight,
        stopPlay      : stopPlay,
        isPlaying     : function () { return !!playToken; }
    };
})();
