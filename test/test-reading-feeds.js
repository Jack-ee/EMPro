/**
 * test-reading-feeds.js - Daily Reading test suite (v100)
 * ============================================================
 * Verifies the on-demand reading feature across all three layers:
 *
 *   Static   version discipline (sw emp-v100, index.html ?v=100,
 *            script tag, SW precache, app.js boot hook).
 *   Worker   the routes run for real in Node with a stubbed
 *            upstream fetch: host whitelists enforced, the Guardian
 *            key attached server-side only, Range passed through,
 *            the pack route untouched.
 *   Module   reading-feeds.js pure logic: source-line parsing,
 *            Guardian query building, cache-cap eviction order.
 *
 * Run:  node test/test-reading-feeds.js     (no dependencies)
 * ============================================================
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log('  ok  ' + name); }
    else      { failed++; console.log('FAIL  ' + name + (detail ? ' - ' + detail : '')); }
}
const ROOT = path.join(__dirname, '..');   // tests live in <repo>/test/
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// --- 1. Static consistency ---------------------------------------

console.log('[static]');
const sw     = read('sw.js');
const html   = read('index.html');
const appJs  = read('app.js');
const feeds  = read('reading-feeds.js');
const worker = read('empro-tts-proxy.js');

check('sw.js CACHE_NAME is emp-v110', sw.includes("const CACHE_NAME = 'emp-v110';"));
const vNew = (html.match(/\?v=110/g) || []).length;
const vOld = (html.match(/\?v=(9[89]|10[0-9])"/g) || []).length;
check('index.html has 21 x ?v=110 and no stale versions',
      vNew === 21 && vOld === 0, vNew + ' new, ' + vOld + ' stale');
check('index.html loads reading-feeds.js',
      html.includes('<script src="reading-feeds.js?v=110"></script>'));
check('index.html has the Daily Reading panel and overlay',
      html.includes('id="rd-panel-feeds"') && html.includes('id="rf-article"'));
check('sw.js precaches reading-feeds.js', sw.includes("'./reading-feeds.js',"));
check('app.js boots ReadingFeeds',
      appJs.includes("safeCall('ReadingFeeds'"));
check('style.css has the feeds styles',
      read('style.css').includes('.rf-article-body'));

// --- 2. Worker routes, run for real -------------------------------

console.log('[worker]');
const calls = [];
function stubUpstream(bodyText, headers, status) {
    return new Response(bodyText, { status: status || 200,
        headers: headers || { 'Content-Type': 'text/xml' } });
}
const sandbox = {
    Response, Request, URL, URLSearchParams, Headers,
    module: { exports: null }, console,
    fetch: async (url, opts) => {
        calls.push({ url: String(url), opts: opts || {} });
        return stubUpstream('<rss><channel></channel></rss>',
            { 'Content-Type'  : 'text/xml',
              'Content-Length': '42',
              'Accept-Ranges' : 'bytes' });
    },
};
vm.createContext(sandbox);
vm.runInContext(worker.replace('export default', 'module.exports ='), sandbox);
const routes = sandbox.module.exports;

function req(url, headers) {
    return new Request(url, {
        headers: Object.assign({ Origin: 'https://jack-ee.github.io' },
                               headers || {}),
    });
}

(async () => {
    const W = 'https://worker.test/';

    // ?fetch: whitelist
    calls.length = 0;
    let r = await routes.fetch(req(W + '?fetch=' +
        encodeURIComponent('https://evil.example.com/feed')), {});
    check('?fetch rejects a non-whitelisted host',
          r.status === 400 && calls.length === 0);

    calls.length = 0;
    r = await routes.fetch(req(W + '?fetch=' +
        encodeURIComponent('https://www.voanews.com/api/ztbopl-vomx-tpekvmm')), {});
    check('?fetch relays a whitelisted VOA feed with no-store',
          r.status === 200 &&
          r.headers.get('Cache-Control') === 'no-store' &&
          calls[0].url.startsWith('https://www.voanews.com/'));
    check('?fetch keeps CORS for the app origin',
          r.headers.get('Access-Control-Allow-Origin') === 'https://jack-ee.github.io');

    calls.length = 0;
    r = await routes.fetch(req(W + '?fetch=' +
        encodeURIComponent('https://learningenglish.voanews.com/api/xyz')), {});
    check('?fetch allows any voanews subdomain via suffix match', r.status === 200);

    calls.length = 0;
    r = await routes.fetch(req(W + '?fetch=' +
        encodeURIComponent('https://feeds.npr.org/500005/podcast.xml')), {});
    check('?fetch allows NPR feeds', r.status === 200);

    calls.length = 0;
    r = await routes.fetch(req(W + '?fetch=' +
        encodeURIComponent('https://podcasts.files.bbci.co.uk/p02nq0gn.rss')), {});
    check('?fetch allows BBC podcast feeds', r.status === 200);

    calls.length = 0;
    r = await routes.fetch(req(W + '?fetch=' +
        encodeURIComponent('https://notvoanews.com/feed')), {});
    check('?fetch suffix match cannot be spoofed by a lookalike domain',
          r.status === 400 && calls.length === 0);

    calls.length = 0;
    r = await routes.fetch(req(W + '?media=' +
        encodeURIComponent('https://chrt.fm/track/x/ondemand.npr.org/e.mp3')), {});
    check('?media allows NPR enclosure redirect hosts', r.status === 200);

    calls.length = 0;
    r = await routes.fetch(req(W + '?media=' + encodeURIComponent(
        'https://prfx.byspotify.com/e/play.podtrac.com/npr-510318/x.mp3')), {});
    check('?media allows the byspotify prefix NPR now uses', r.status === 200);

    // ?media: Range passthrough
    calls.length = 0;
    r = await routes.fetch(req(W + '?media=' +
        encodeURIComponent('https://av.voanews.com/clips/x.mp3'),
        { Range: 'bytes=100-' }), {});
    check('?media forwards the Range header upstream',
          calls[0] && calls[0].opts.headers &&
          new Headers(calls[0].opts.headers).get('Range') === 'bytes=100-');
    check('?media exposes range headers over CORS',
          (r.headers.get('Access-Control-Expose-Headers') || '')
              .includes('Content-Range'));
    calls.length = 0;
    r = await routes.fetch(req(W + '?media=' +
        encodeURIComponent('https://evil.example.com/x.mp3')), {});
    check('?media rejects a non-whitelisted host',
          r.status === 400 && calls.length === 0);

    // ?guardian: key handling
    calls.length = 0;
    r = await routes.fetch(req(W + '?guardian=' +
        encodeURIComponent('search?section=world')), {});
    check('?guardian without a key returns a clear 500',
          r.status === 500 && (await r.text()).includes('GUARDIAN_API_KEY'));

    calls.length = 0;
    r = await routes.fetch(req(W + '?guardian=' +
        encodeURIComponent('search?section=world&page-size=20')),
        { GUARDIAN_API_KEY: 'sekret' });
    check('?guardian attaches the env key server-side',
          r.status === 200 &&
          calls[0].url.startsWith('https://content.guardianapis.com/search?') &&
          calls[0].url.includes('api-key=sekret'));

    calls.length = 0;
    r = await routes.fetch(req(W + '?guardian=' +
        encodeURIComponent('search?api-key=steal')),
        { GUARDIAN_API_KEY: 'sekret' });
    check('?guardian rejects client-supplied api-key',
          r.status === 400 && calls.length === 0);

    // Pack route still the GET default
    calls.length = 0;
    sandbox.fetch = async (url) => {
        calls.push({ url: String(url) });
        return stubUpstream('PACKBYTES', { 'Content-Type': 'application/octet-stream' });
    };
    r = await routes.fetch(req(W + '?asset=empro-audio-pack.manifest.json'), {});
    check('?asset pack route still works and is no-store for the manifest',
          r.status === 200 &&
          r.headers.get('Cache-Control') === 'no-store' &&
          calls[0].url.includes('/releases/download/audio-pack/'));

    // --- 3. Module pure logic -------------------------------------

    console.log('[module]');
    const modSandbox = { window: {}, console };
    vm.createContext(modSandbox);
    vm.runInContext(feeds, modSandbox);
    const I = modSandbox.window.ReadingFeeds._internals;

    const srcs = I.parseSources(
        '# comment\n' +
        'Guardian \u00b7 World | guardian:section=world\n' +
        'VOA Sci | https://www.voanews.com/api/abc\n' +
        'bad line without bar\n' +
        'No Target | \n' +
        'Insecure | http://plain.example.com/feed\n');
    check('parseSources keeps valid lines only', srcs.length === 2,
          JSON.stringify(srcs.map(s => s.name)));
    check('parseSources types guardian vs rss',
          srcs[0].type === 'guardian' && srcs[0].params === 'section=world' &&
          srcs[1].type === 'rss' && srcs[1].url.endsWith('/api/abc'));

    const q = I.guardianListQuery('section=world');
    check('guardianListQuery builds the search query',
          q.startsWith('search?') && q.includes('order-by=newest') &&
          q.includes('show-fields=trailText,wordcount') &&
          q.endsWith('&section=world'));
    check('guardianListQuery works with no extra params',
          !I.guardianListQuery('').includes('&&') &&
          !I.guardianListQuery('').endsWith('&'));

    // pickItemAudio against duck-typed elements mimicking a parsed
    // <item>: media:content (localName 'content') must be recognised,
    // audio-typed entries must beat plain mp3 fallbacks.
    const fakeEl = (localName, attrs) => ({
        localName, getAttribute: k => attrs[k] || null });
    const fakeItem = els => ({ getElementsByTagName: () => els });

    check('pickItemAudio reads Media-RSS media:content (VOA style)',
          I.pickItemAudio(fakeItem([
              fakeEl('title',   {}),
              fakeEl('content', { url : 'https://av.voanews.com/e.mp3',
                                  type: 'audio/mpeg' }),
          ])) === 'https://av.voanews.com/e.mp3');
    check('pickItemAudio still reads a plain enclosure',
          I.pickItemAudio(fakeItem([
              fakeEl('enclosure', { url : 'https://av.voanews.com/p.mp3',
                                    type: 'audio/mpeg' }),
          ])) === 'https://av.voanews.com/p.mp3');
    check('pickItemAudio prefers audio-typed over video in media:group',
          I.pickItemAudio(fakeItem([
              fakeEl('content', { url : 'https://av.voanews.com/v.mp4',
                                  type: 'video/mp4' }),
              fakeEl('content', { url   : 'https://av.voanews.com/a.mp3',
                                  medium: 'audio' }),
          ])) === 'https://av.voanews.com/a.mp3');
    check('pickItemAudio falls back to the first https mp3 url',
          I.pickItemAudio(fakeItem([
              fakeEl('enclosure', { url: 'https://av.voanews.com/x.mp3?a=1' }),
          ])) === 'https://av.voanews.com/x.mp3?a=1');
    check('pickItemAudio returns null with no media at all',
          I.pickItemAudio(fakeItem([fakeEl('title', {})])) === null);
    check('pickItemAudio accepts http enclosures (BBC redirector)',
          I.pickItemAudio(fakeItem([
              fakeEl('enclosure', { url : 'http://open.live.bbc.co.uk/x/y.mp3',
                                    type: 'audio/mpeg' }),
          ])) === 'http://open.live.bbc.co.uk/x/y.mp3');
    check('likelyAudio flags VOA links without declared audio only',
          I.likelyAudio({ audio: null, link: 'https://www.voanews.com/a/1.html' })
          === true &&
          I.likelyAudio({ audio: 'x', link: 'https://www.voanews.com/a/1.html' })
          === false &&
          I.likelyAudio({ audio: null, link: 'https://theguardian.com/x' })
          === false);

    const html1 = '<div data-sources=\'[{"Src":"https://av.voanews.com/' +
        'clips/VLE/2026/08/abc-128k.mp3?x=1&amp;y=2"}]\'></div>';
    check('findPageAudio finds the embedded VOA mp3 and unescapes it',
          I.findPageAudio(html1) ===
          'https://av.voanews.com/clips/VLE/2026/08/abc-128k.mp3?x=1&y=2');
    check('findPageAudio returns null when a page has no audio',
          I.findPageAudio('<html><body>text only</body></html>') === null);
    check('findPageAudio ignores non-VOA hosts',
          I.findPageAudio('<a href="https://evil.com/x.mp3">x</a>') === null);
    check('findPageAudio handles JSON-escaped URLs in page blobs',
          I.findPageAudio('{"url":"https:\\/\\/av.voanews.com\\/clips\\/e.mp3"}')
          === 'https://av.voanews.com/clips/e.mp3');
    check('findPageAudio accepts any voanews subdomain',
          I.findPageAudio('src="https://media.voanews.com/x/y.m4a"')
          === 'https://media.voanews.com/x/y.m4a');

    const MB = 1048576;
    const rows = [
        { id: 'a', size: 60 * MB, lastOpenedAt: 3 },
        { id: 'b', size: 60 * MB, lastOpenedAt: 1 },   // oldest
        { id: 'c', size: 60 * MB, lastOpenedAt: 2 },
    ];
    check('pickEvictions removes least-recently-opened first',
          JSON.stringify(I.pickEvictions(rows, 130 * MB, null)) ===
          JSON.stringify(['b']));
    check('pickEvictions never evicts the open article',
          JSON.stringify(I.pickEvictions(rows, 70 * MB, 'b')) ===
          JSON.stringify(['c', 'a']));
    check('pickEvictions is a no-op under the cap',
          I.pickEvictions(rows, 500 * MB, null).length === 0);

    console.log('\n%d passed, %d failed', passed, failed);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
