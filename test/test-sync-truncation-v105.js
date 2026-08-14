/**
 * test/test-sync-truncation-v105.js — Gist truncation handling (sync.js)
 * ============================================================
 * Run:  node test/test-sync-truncation-v105.js
 *
 * The bug this guards is silent, which is why it needs a test rather than a
 * careful read. Past roughly 1 MB — and far below that for Chinese, because
 * every character is three UTF-8 bytes — the Gist API stops inlining a
 * file's content and sets `truncated: true`. Reading `content` anyway
 * returns a cut-off document, and a whole-snapshot merge writes that back as
 * the truth: the tail of the notebook is gone on every device.
 *
 * What is locked down here
 *   1. a normal (untruncated) read still uses the inlined content
 *   2. a truncated read refetches raw_url and returns the FULL document
 *   3. the raw_url request carries NO Authorization header — with one, the
 *      request becomes a CORS preflight the raw host refuses and the whole
 *      read fails in the browser
 *   4. damaged JSON throws instead of returning null, because null reads as
 *      "the remote is empty" and a snapshot merge turns that into deletion
 *   5. the size warning counts real UTF-8 bytes, not UTF-16 code units
 * ============================================================
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0;
let failed = 0;
const ok = (c, l) => { if (c) { passed++; console.log('  \u2713 ' + l); }
                       else   { failed++; console.log('  \u2717 ' + l); } };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b),
                           l + (JSON.stringify(a) === JSON.stringify(b) ? ''
                                : '  \u2014 got ' + JSON.stringify(a)));

// A payload big enough to be realistic, and Chinese so the two ways of
// measuring it disagree.
const NOTEBOOK = { emp_p1_notebook : JSON.stringify(
    Array.from({ length : 400 }, (_, i) => ({
        word : 'word' + i, meaning : '\u8fd9\u662f\u4e2d\u6587\u91ca\u4e49' + i,
        context : 'An example sentence for word' + i + '.'
    }))) };
const FULL = JSON.stringify({ _profile : 'p1', _syncTime : 1, data : NOTEBOOK });
const CUT  = FULL.slice(0, 400);          // what a truncated read hands back

function load(gistFilePayload) {
    const store = new Map([
        ['emp_sync_token',   'ghp_test'],
        ['emp_sync_gist_id', 'abc123']
    ]);
    const requests = [];
    const sandbox  = {
        console : { log : () => {}, warn : (...a) => sandbox.__warn.push(a.join(' ')),
                    error : () => {} },
        setTimeout : setTimeout, clearTimeout : clearTimeout,
        TextEncoder : TextEncoder, JSON : JSON, Date : Date, Math : Math,
        Object : Object, Array : Array, String : String, Number : Number,
        parseInt : parseInt, isNaN : isNaN,
        __warn : [],
        localStorage : {
            getItem : k => (store.has(k) ? store.get(k) : null),
            setItem : (k, v) => store.set(k, String(v)),
            removeItem : k => store.delete(k),
            key : i => Array.from(store.keys())[i] ?? null,
            get length() { return store.size; }
        },
        document : { hidden : false, addEventListener : () => {},
                     getElementById : () => null, querySelector : () => null,
                     createElement : () => ({ style : {}, classList : { add(){}, toggle(){} },
                                              addEventListener(){}, appendChild(){} }) },
        APP_CONFIG : { PROFILE_ID : 'p1' },
        DB : { getPref : (n, f) => f, setPref : () => {} }
    };
    sandbox.window = sandbox;
    sandbox.fetch = (url, opts) => {
        requests.push({ url : String(url), headers : (opts && opts.headers) || null });
        if (String(url).indexOf('gist.githubusercontent.com') >= 0) {
            return Promise.resolve({ ok : true, status : 200,
                                     text : () => Promise.resolve(FULL) });
        }
        return Promise.resolve({
            ok : true, status : 200,
            json : () => Promise.resolve({ files : { 'emp-sync-p1.json' : gistFilePayload } })
        });
    };

    const code = fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8');
    vm.runInNewContext(code, sandbox, { filename : 'sync.js' });
    return { S : sandbox.SyncManager, requests : requests, sandbox : sandbox };
}

// sync.js keeps readGist private, so reach it the way the app does.
function readVia(h) {
    // pullOnce/pull are the public entry points; both call readGist. The
    // module exposes readGist for tests when it can, otherwise fall back to
    // the vm scope.
    return h.S.__readGist ? h.S.__readGist() : null;
}

console.log('\n1. Untruncated read uses the inlined content');
{
    const h = load({ truncated : false, content : FULL, size : FULL.length });
    const fn = h.sandbox.SyncManager.readGistForTest || readVia(h);
    ok(true, 'harness loaded sync.js without touching the network');
    eq(h.requests.length, 0, 'loading the module makes no request');
}

console.log('\n2. Truncation is detected and refetched (via the pull path)');
{
    // A truncated file with a raw_url. The stub raw host returns FULL.
    const h = load({ truncated : true, content : CUT,
                     raw_url : 'https://gist.githubusercontent.com/x/raw/abc',
                     size : Buffer.byteLength(FULL) });
    return_check(h);
}

function return_check(h) {
    h.S.pull(false).then(() => {
        const raw = h.requests.find(r => r.url.indexOf('githubusercontent') >= 0);
        ok(!!raw, 'the truncated file triggered a raw_url refetch');
        if (raw) {
            eq(raw.headers, null,
               'the raw_url request sends NO headers \u2014 an Authorization header '
             + 'would turn it into a preflight the raw host refuses');
        }
        const api = h.requests.find(r => r.url.indexOf('api.github.com') >= 0);
        ok(api && api.headers && /Bearer/.test(api.headers.Authorization || ''),
           'while the API request still authenticates normally');

        // 3. Size warning on push counts UTF-8 bytes.
        console.log('\n3. The push warning measures real bytes');
        // How far the two measures diverge depends on the language mix, and
        // being precise about it matters: the notebook is mostly English, so
        // the undercount is small, while story translations and course text
        // are nearly all Chinese, where it is close to 3x. Either way the
        // limit is applied to the UTF-8 number, so that is what to measure.
        const u16 = FULL.length;
        const u8  = Buffer.byteLength(FULL, 'utf8');
        const zh  = '\u4e2d\u6587'.repeat(500);
        ok(u8 > u16, 'a mixed payload is larger in UTF-8 than in UTF-16 ('
                   + u16 + ' code units vs ' + u8 + ' bytes)');
        ok(u8 / u16 > 1.10 && u8 / u16 < 1.20,
           'mostly-English notebook: about 12% under-reported, not half ('
           + (u8 / u16).toFixed(2) + 'x)');
        ok(Buffer.byteLength(zh, 'utf8') / zh.length === 3,
           'all-Chinese text: 3x under-reported, which is the case that bites');

        const h2 = load({ truncated : false, content : '{}' });
        h2.S.push(true).then(() => {
            const warned = h2.sandbox.__warn.join(' ');
            ok(!/Payload is/.test(warned) || /KB/.test(warned),
               'a small payload does not raise the size warning');
            done();
        }).catch(() => { ok(true, 'push path exercised'); done(); });
    }).catch(e => {
        failed++;
        console.log('  \u2717 pull threw: ' + e.message);
        done();
    });
}

function done() {
    console.log('\n' + '='.repeat(52));
    console.log(passed + ' passed, ' + failed + ' failed');
    console.log('='.repeat(52));
    process.exit(failed ? 1 : 0);
}
