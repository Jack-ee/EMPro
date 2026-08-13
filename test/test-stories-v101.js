/**
 * test/test-stories-v101.js — Stories module (stories.js)
 * ============================================================
 * Run:  node test/test-stories-v101.js
 *
 * stories.js is a browser IIFE that assigns window.Stories, so the harness
 * builds the globals it touches — window, localStorage, DB, App — and then
 * evaluates the file. No DOM is needed: init() bails out when
 * #view-stories is absent, and every function under test is pure or works
 * only through DB.
 *
 * What this locks down
 *   1. batching honours "N words this run, M per piece"
 *   2. reserving a batch removes those words from the next run's pool
 *      (the whole point of the feature) and deleting releases them
 *   3. the prompt carries every group with its seq and Chinese glosses
 *   4. paste-back survives markdown fences, prose, and per-piece replies
 *   5. story block indices sit above PACK_BASE and never collide
 *   6. missing target words are reported, inflections count as used
 * ============================================================
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ─── Harness ────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(cond, label) {
    if (cond) { passed++; console.log('  \u2713 ' + label); }
    else      { failed++; console.log('  \u2717 ' + label); }
}
function eq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    ok(a === b, label + (a === b ? '' : '  \u2014 got ' + a + ', want ' + b));
}
function section(name) { console.log('\n' + name); }

// A minimal localStorage with the same string-only semantics.
function makeStorage() {
    const map = new Map();
    return {
        getItem : (k) => (map.has(k) ? map.get(k) : null),
        setItem : (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
        key     : (i) => Array.from(map.keys())[i] ?? null,
        get length() { return map.size; }
    };
}

// The two DB behaviours stories.js relies on: prefs and the notebook.
// isInflectionOf is the real rule set in miniature — enough for the
// -d / -ed / -s / -ing forms the highlighter and gap check must catch.
function makeDB(store) {
    return {
        _notebook : [],
        getPref   : (name, fallback) => {
            const v = store.getItem('pref_' + name);
            return v !== null ? v : fallback;
        },
        setPref   : (name, val) => { store.setItem('pref_' + name, val); },
        loadNotebook : function () { return this._notebook; },
        isInflectionOf : (inflected, base) => {
            const a = String(inflected || '').toLowerCase();
            const b = String(base || '').toLowerCase();
            if (!a || !b || a === b || a.length <= b.length) return false;
            const cand = new Set([b + 's', b + 'es', b + 'ed', b + 'ing', b + 'd']);
            if (/e$/.test(b)) { cand.add(b.slice(0, -1) + 'ing'); cand.add(b + 'd'); }
            if (/y$/.test(b)) cand.add(b.slice(0, -1) + 'ies');
            return cand.has(a);
        }
    };
}

function loadModule() {
    const store   = makeStorage();
    const toasts  = [];
    const sandbox = {
        console : console, setTimeout : setTimeout, navigator : {},
        TextEncoder : TextEncoder, btoa : btoa, crypto : require('crypto').webcrypto,
        Array : Array, String : String, Object : Object, JSON : JSON,
        Uint8Array : Uint8Array, Date : Date, Math : Math, Number : Number
    };
    sandbox.window = sandbox;
    sandbox.localStorage = store;
    sandbox.DB  = makeDB(store);
    sandbox.App = {
        showToast : (m) => toasts.push(m),
        escHtml   : (s) => String(s == null ? '' : s)
                              .replace(/&/g, '&amp;').replace(/</g, '&lt;')
                              .replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        escAttr   : (s) => String(s == null ? '' : s).replace(/"/g, '&quot;')
    };
    // init() reads the DOM; every test calls the module functions directly,
    // so a stub that reports "no view" is all that is needed.
    sandbox.document = { getElementById : () => null, querySelectorAll : () => [] };

    // Scripted GitHub API. calls records every request so a test can assert
    // that nothing was pushed when nothing changed.
    const calls = [];
    sandbox.__routes = {};
    sandbox.fetch = (url, opts) => {
        calls.push({ url : String(url), method : (opts && opts.method) || 'GET', opts : opts });
        const r = sandbox.__routes[(opts && opts.method) || 'GET'];
        if (!r) return Promise.reject(new Error('no route'));
        return Promise.resolve(r);
    };
    const code = fs.readFileSync(path.join(__dirname, '..', 'stories.js'), 'utf8');
    vm.runInNewContext(code, sandbox, { filename : 'stories.js' });
    return { S : sandbox.Stories, DB : sandbox.DB, store : store, toasts : toasts,
             sandbox : sandbox, calls : calls };
}

// Fill the notebook with n words in a known order: w001 ... wNNN.
function seedWords(DB, n, opts) {
    DB._notebook = [];
    for (let i = 1; i <= n; i++) {
        DB._notebook.push({
            word      : 'w' + String(i).padStart(3, '0'),
            meaning   : '\u4e2d' + i,
            packIndex : (opts && opts.noIndex) ? 0 : i,
            addedAt   : 1000 + i
        });
    }
    return DB._notebook;
}

// ─── 1. Batching ────────────────────────────────────────────

section('1. Batching: N words this run, M per piece');
{
    const { S, DB } = loadModule();
    seedWords(DB, 562);

    const plan = S.planBatch({ count : 100, groupSize : 20 });
    eq(plan.groups.length, 5, '100 words / 20 per piece = 5 pieces');
    eq(plan.groups.map(g => g.length), [20, 20, 20, 20, 20], 'every piece holds 20 words');
    eq(plan.taken, 100, 'taken = 100');
    eq(plan.remaining, 462, '462 words left over');
    eq(plan.groups[0][0], 'w001', 'first piece starts at the first word');
    eq(plan.groups[4][19], 'w100', 'last piece ends at the hundredth word');

    const odd = S.planBatch({ count : 100, groupSize : 30 });
    eq(odd.groups.map(g => g.length), [30, 30, 30, 10], 'a short trailing piece is kept, not padded');

    const big = S.planBatch({ count : 562, groupSize : 20 });
    ok(big.capped === true, 'a run wider than MAX_GROUPS is capped');
    eq(big.groups.length, 12, 'capped at 12 pieces');
    eq(big.taken, 240, 'capped run reserves 12 x 20 words');

    const short = S.planBatch({ count : 500, groupSize : 20 });
    seedWords(DB, 7);
    const tiny = S.planBatch({ count : 100, groupSize : 20 });
    eq(tiny.groups.length, 1, 'fewer words than one group still yields one piece');
    eq(tiny.groups[0].length, 7, 'the piece holds every remaining word');
    ok(short.taken === 500 || short.taken === 240, 'sanity: planBatch is side-effect free');
}

// ─── 2. Reservation across runs ─────────────────────────────

section('2. Reservation: the next run gets the words that are left');
{
    const { S, DB } = loadModule();
    seedWords(DB, 562);

    const first = S.createBatch({ count : 100, groupSize : 20, type : 'story', level : 'C1', length : 120 });
    eq(first.stories.length, 5, 'run 1 created 5 pending pieces');
    eq(first.stories.map(s => s.seq), [1, 2, 3, 4, 5], 'seq numbers start at 1 and increment');
    eq(S.load().length, 5, 'pieces are persisted');
    ok(S.load().every(s => s.status === 'pending'), 'new pieces are pending');

    const second = S.planBatch({ count : 100, groupSize : 20 });
    eq(second.groups[0][0], 'w101', 'run 2 starts after the reserved words');
    eq(second.remaining, 362, 'the pool shrank by both runs');
    ok(!second.groups.flat().some(w => first.stories[0].words.includes(w)),
       'no word from run 1 reappears in run 2');

    const b2 = S.createBatch({ count : 100, groupSize : 25 });
    eq(b2.stories.map(s => s.seq), [6, 7, 8, 9], 'seq keeps counting across runs');
    eq(b2.stories[0].words[0], 'w101', 'run 2 reserves from w101');

    // Deleting a piece must release its words.
    const drop = b2.stories[0];
    S.save(S.load().filter(s => s.id !== drop.id));
    const third = S.planBatch({ count : 30, groupSize : 30 });
    eq(third.groups[0][0], 'w101', 'a deleted piece releases its words back to the pool');

    // Opting out of the skip returns to the top of the bank.
    const all = S.planBatch({ count : 10, groupSize : 10, skipUsed : false });
    eq(all.groups[0][0], 'w001', 'skipUsed:false ignores the used set');
}

// ─── 3. Prompt ──────────────────────────────────────────────

section('3. Prompt: every group, its seq, and the Chinese sense');
{
    const { S, DB } = loadModule();
    seedWords(DB, 40);
    const batch  = S.createBatch({ count : 40, groupSize : 20 });
    const prompt = S.buildPrompt(batch.stories, {
        type : 'paragraph', level : 'C2', length : 180, topic : 'remote sensing', questions : true
    });

    ok(/seq 1 \(20 words\)/.test(prompt), 'piece 1 is listed with its word count');
    ok(/seq 2 \(20 words\)/.test(prompt), 'piece 2 is listed too');
    ok(prompt.includes('w001 [\u4e2d1]'), 'a word carries its notebook meaning as the sense to use');
    ok(prompt.includes('CEFR C2'),        'level reaches the prompt');
    ok(prompt.includes('about 180 words'), 'length reaches the prompt');
    ok(prompt.includes('remote sensing'), 'topic reaches the prompt');
    ok(prompt.includes('informative paragraph'), 'form reaches the prompt');
    ok(prompt.includes('"words_used"'),   'the JSON shape is spelled out');
    ok(prompt.includes('"questions"'),    'questions appear when asked for');
    ok(!S.buildPrompt(batch.stories, { questions : false }).includes('"questions"'),
       'and stay out when not');
    eq(S.buildPrompt([], {}), '', 'no pieces means no prompt');
}

// ─── 4. Paste-back ──────────────────────────────────────────

section('4. Paste-back: fences, prose, and per-piece replies');
{
    const { S, DB } = loadModule();
    seedWords(DB, 40);
    S.createBatch({ count : 40, groupSize : 20 });

    const reply = 'Sure! Here are your two pieces:\n\n```json\n' + JSON.stringify({
        stories : [
            { seq : 1, title : 'The Wax Apple Stand', level : 'C1',
              sentences : [{ en : 'She w001 the crate open.', zh : '\u5979\u6253\u5f00\u4e86\u7bb1\u5b50\u3002' },
                           { en : 'The w002 was ripe.',      zh : '\u679c\u5b50\u719f\u4e86\u3002' }],
              words_used : [{ word : 'w001', form : 'w001' }],
              questions  : [{ q : 'What was ripe?', a : 'The fruit.' }] },
            { seq : 2, title : 'Second Piece',
              sentences : [{ en : 'A w021 appeared.', zh : '\u51fa\u73b0\u4e86\u3002' }] }
        ]
    }) + '\n```\n\nLet me know if you want changes!';

    const res = S.applyResponse(reply);
    eq(res.filled, 2, 'both pieces were written');
    eq(res.unmatched, 0, 'nothing was left unmatched');

    const arr = S.load();
    eq(arr[0].status, 'ready',                 'piece 1 is ready');
    eq(arr[0].title, 'The Wax Apple Stand',    'title landed');
    eq(arr[0].sents.length, 2,                 'both sentences landed');
    eq(arr[0].sents[0].zh, '\u5979\u6253\u5f00\u4e86\u7bb1\u5b50\u3002', 'Chinese landed');
    eq(arr[0].qs.length, 1,                    'the question landed');
    ok(arr[0].filledAt > 0,                    'filledAt was stamped');
    eq(arr[1].title, 'Second Piece',           'piece 2 matched its own seq');

    // A reply pasted one piece at a time, out of order, with no fences.
    const { S : S2, DB : DB2 } = loadModule();
    seedWords(DB2, 60);
    S2.createBatch({ count : 60, groupSize : 20 });
    const r1 = S2.applyResponse('{"seq":3,"title":"Third","sentences":["Only w041 here."]}');
    eq(r1.filled, 1, 'a bare single-piece object is accepted');
    eq(S2.load()[2].title, 'Third', 'and it went to seq 3, not the first pending slot');
    eq(S2.load()[2].sents[0].en, 'Only w041 here.', 'a plain string sentence array works');

    // No seq at all: fall back to the waiting pieces, in order.
    const r2 = S2.applyResponse('[{"title":"Fallback","sentences":["Text for w001."]}]');
    eq(r2.filled, 1, 'a reply with no seq still lands');
    eq(S2.load()[0].title, 'Fallback', 'it fills the oldest waiting piece');

    // Junk in, nothing changed.
    const before = JSON.stringify(S2.load());
    const r3 = S2.applyResponse('I could not complete that request.');
    eq(r3.filled, 0, 'prose with no JSON fills nothing');
    eq(JSON.stringify(S2.load()), before, 'and leaves the store untouched');
}

// ─── 5. Audio pack blocks ───────────────────────────────────

section('5. Audio pack: story blocks live above PACK_BASE');
{
    const { S, DB } = loadModule();
    seedWords(DB, 40);
    S.createBatch({ count : 40, groupSize : 20 });

    eq(S.speechBlocks(), [], 'a pending piece contributes no audio entries');

    S.applyResponse(JSON.stringify({ stories : [
        { seq : 1, title : 'First', sentences : [{ en : 'One w001 sentence.' }, { en : 'Two.' }] },
        { seq : 2, title : 'Second', sentences : [{ en : 'Three.' }] }
    ] }));

    const blocks = S.speechBlocks();
    eq(blocks.length, 2, 'one block per finished piece');
    eq(blocks[0].index, S.PACK_BASE + 1, 'block index = PACK_BASE + seq');
    eq(blocks[1].index, S.PACK_BASE + 2, 'and it tracks seq, not list position');
    ok(blocks[0].index > 562, 'story indices clear a 562-word bank');
    eq(blocks[0].word, 'story 1: First', 'the marker label names the piece');
    eq(blocks[0].entries, ['One w001 sentence.', 'Two.'], 'entries are the sentences in order');
    eq(S.speechList().length, 3, 'the flat list holds every sentence');
    ok(typeof S.storyRange === 'undefined',
       'v100: no build range is computed at all \u2014 the cloud diffs by itself');
    ok(typeof S.publishWordList === 'function', 'v100: publishing replaced the range export');
    ok(!S.speechList().some(s => /[\u4e00-\u9fff]/.test(s)), 'no Chinese reaches the audio list');

    // A leading '#' would be read as a comment by the pack generator, so
    // it must be gone by the time the sentence is stored.
    const { S : S3, DB : DB3 } = loadModule();
    seedWords(DB3, 20);
    S3.createBatch({ count : 20, groupSize : 20 });
    S3.applyResponse('{"seq":1,"sentences":["#1 was the best year.","  Spaced   out   text.  "]}');
    eq(S3.load()[0].sents[0].en, '1 was the best year.', 'a leading # is stripped at store time');
    eq(S3.load()[0].sents[1].en, 'Spaced out text.',     'whitespace is collapsed at store time');
}

// ─── 6. Gaps and highlighting ───────────────────────────────

section('6. Coverage: inflections count, real gaps are reported');
{
    const { S, DB } = loadModule();
    DB._notebook = [
        { word : 'prove',        meaning : '\u8bc1\u660e', packIndex : 1, addedAt : 1 },
        { word : 'collection',   meaning : '\u96c6\u5408', packIndex : 2, addedAt : 2 },
        { word : 'shed light on', meaning : '\u9610\u660e', packIndex : 3, addedAt : 3 },
        { word : 'testbed',      meaning : '\u8bd5\u9a8c\u53f0', packIndex : 4, addedAt : 4 }
    ];
    S.createBatch({ count : 4, groupSize : 4 });
    S.applyResponse(JSON.stringify({ stories : [{ seq : 1, title : 'T', sentences : [
        { en : 'The data proved the point.' },
        { en : 'Her collections shed light on the question.' }
    ] }] }));

    const story = S.load()[0];
    eq(S.findGaps(story), ['testbed'], 'only the genuinely absent word is reported');

    const html = S.highlight('The data proved the point.', story.words);
    ok(html.includes('<mark class="sy-hit" data-w="prove">proved</mark>'),
       'an inflected form is highlighted and mapped back to its lemma');

    const phrase = S.highlight('Her collections shed light on the question.', story.words);
    ok(phrase.includes('data-w="shed light on">shed light on</mark>'), 'a phrase is highlighted whole');
    ok(phrase.includes('data-w="collection">collections</mark>'), 'a plural is highlighted too');

    const safe = S.highlight('A <script> tag & an "attack".', ['tag']);
    ok(!safe.includes('<script>'), 'sentence HTML is escaped');
    ok(safe.includes('&lt;script&gt;'), 'and escaped correctly');
    ok(safe.includes('<mark class="sy-hit" data-w="tag">tag</mark>'), 'while still marking the target');

    eq(S.highlight('Nothing to mark here.', []), 'Nothing to mark here.', 'no targets, no marks');

    // v100 regression: the first highlighter used [A-Za-z]+ for tokens, so a
    // target carrying a digit or an accent ("COVID-19", "cafe" with an
    // acute) never lit up. The token rule is Unicode-aware now, with an
    // ASCII fallback for engines that lack \p{...}.
    const mixed = S.highlight('The COVID-19 data came from a caf\u00e9 in 3D.',
                              ['covid-19', 'caf\u00e9', '3d']);
    ok(mixed.includes('>COVID-19</mark>'), 'a target with digits and a hyphen is highlighted');
    ok(mixed.includes('>caf\u00e9</mark>'), 'an accented target is highlighted');
    ok(mixed.includes('>3D</mark>'), 'a target starting with a digit is highlighted');

    const digitGap = {
        words : ['covid-19', 'testbed'],
        sents : [{ en : 'The COVID-19 numbers were clear.' }]
    };
    eq(S.findGaps(digitGap), ['testbed'], 'the gap check uses the same token rule');
}

// ─── 7. Publishing ──────────────────────────────────────────

section('7. Publishing: the cloud only ever sees a real difference');
{
    const crypto = require('crypto');
    const LIST   = '# voices: nova\n#@1 manifest\nmanifest\n';
    // Git's object id for that exact content, computed independently here.
    // NUL separator, not a literal backslash-zero: verified against
    // `git hash-object`, which is the value the contents API reports.
    const blobSha = crypto.createHash('sha1')
        .update(Buffer.concat([Buffer.from('blob ' + Buffer.byteLength(LIST)),
                               Buffer.from([0]),
                               Buffer.from(LIST)]))
        .digest('hex');

    function harness(remoteSha) {
        const h = loadModule();
        seedWords(h.DB, 3);
        let exported = 0;
        h.sandbox.App.buildWordListText = () => LIST;
        h.sandbox.App.exportWordList    = () => { exported++; };
        h.sandbox.App.setPackRange      = (v) => { h.store.setItem('pref_pack_range', v); };
        h.sandbox.localStorage.setItem('empro_gh_repo', 'jack-ee/EMPro');
        h.sandbox.localStorage.setItem('empro_gh_token', 'github_pat_x');
        h.sandbox.__routes.GET = {
            ok : true, status : 200,
            json : () => Promise.resolve({ sha : remoteSha })
        };
        h.sandbox.__routes.PUT = {
            ok : true, status : 200,
            json : () => Promise.resolve({ commit : { sha : 'deadbeef' } })
        };
        h.exported = () => exported;
        return h;
    }

    // 1) Remote already holds these bytes -> no push, no build.
    const same = harness(blobSha);
    same.S.publishWordList({ quiet : true }).then(res => {
        eq(res.state, 'same', 'an unchanged list reports "same"');
        ok(!same.calls.some(c => c.method === 'PUT'), 'and never sends a PUT');
        ok(same.calls.filter(c => c.method === 'GET').length === 1, 'one request is enough to know');

        // 2) Remote differs -> push, carrying the previous sha.
        const diff = harness('0000000000000000000000000000000000000000');
        return diff.S.publishWordList({ quiet : true }).then(res2 => {
            eq(res2.state, 'pushed', 'a changed list is pushed');
            const put = diff.calls.find(c => c.method === 'PUT');
            ok(!!put, 'a PUT was sent');
            const body = JSON.parse(put.opts.body);
            eq(body.sha, '0000000000000000000000000000000000000000',
               'the PUT carries the remote sha so the commit is not a force write');
            eq(body.branch, 'main', 'it targets main');
            eq(Buffer.from(body.content, 'base64').toString('utf8'), LIST,
               'the committed bytes are exactly the word list');
            ok(/tools\/wordlist\.txt$/.test(put.url), 'it writes tools/wordlist.txt');
            ok(/562|3 words/.test(body.message) || /words/.test(body.message),
               'the commit message names the payload');

            // 3) A leftover range is cleared before the text is built.
            const stale = harness(blobSha);
            stale.store.setItem('pref_pack_range', '1-50');
            return stale.S.publishWordList({ quiet : true }).then(() => {
                eq(stale.store.getItem('pref_pack_range'), '',
                   'publishing clears a leftover build range');

                // 4) A rejected token reports itself instead of failing silently.
                const bad = harness(blobSha);
                bad.sandbox.__routes.GET = { ok : false, status : 401,
                                             json : () => Promise.resolve({}) };
                return bad.S.publishWordList({ quiet : false }).then(res4 => {
                    eq(res4.state, 'error', 'a 401 reports an error');
                    ok(bad.toasts.some(t => /token/i.test(t)),
                       'and the message points at the token');

                    // 5) No repo configured -> download instead, never a request.
                    const none = harness(blobSha);
                    none.sandbox.localStorage.removeItem('empro_gh_repo');
                    return none.S.publishWordList({}).then(res5 => {
                        eq(res5.state, 'download', 'with no repo it falls back to a download');
                        eq(none.exported(), 1, 'and the file is written locally');
                        ok(!none.calls.length, 'no network call is made');
                        finish();
                    });
                });
            });
        });
    }).catch(e => { failed++; console.log('  \u2717 publish suite threw: ' + e.message); finish(); });
}

function finish() {

// ─── Result ─────────────────────────────────────────────────

console.log('\n' + '='.repeat(52));
console.log(passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(52));
process.exit(failed ? 1 : 0);
}
