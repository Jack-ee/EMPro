/**
 * test/test-pack-parts-v102.js — split-pack client (tts-pack.js)
 * ============================================================
 * Run:  npm install fake-indexeddb  &&  node test/test-pack-parts-v102.js
 *
 * The generator's side of the split is covered by
 * test/test_audio_parts_v102.py. This is the other half: given a v2
 * manifest, the client must fetch only the parts whose sha256 it does not
 * already hold, verify each one, and record each one as it lands so an
 * interrupted download resumes instead of restarting 1.4 GB.
 *
 * What is locked down
 *   1. a first download fetches every part and imports every clip
 *   2. a second download with nothing changed fetches no part at all
 *   3. one changed part is the only part fetched
 *   4. an interrupted download keeps the parts already imported, and the
 *      retry starts at the part that failed
 *   5. a part whose bytes do not match its sha256 is rejected, and none of
 *      its clips are imported
 *   6. the manifest is requested with cache-busting and no-store
 *   7. a v1 (pre-split) manifest still uses the monolithic path
 * ============================================================
 */
'use strict';

try { require.resolve('fake-indexeddb'); }
catch (e) {
    console.log('fake-indexeddb is not installed - run:  npm install fake-indexeddb');
    process.exit(0);
}

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const crypto = require('crypto');

let passed = 0;
let failed = 0;
const ok = (c, l) => { if (c) { passed++; console.log('  \u2713 ' + l); }
                       else   { failed++; console.log('  \u2717 ' + l); } };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b),
    l + (JSON.stringify(a) === JSON.stringify(b) ? '' : '  \u2014 got ' + JSON.stringify(a)));

// --- Build real .empack bytes, the way the generator does ----------------

function buildPart(clips, span) {
    const entries = [];
    const chunks  = [];
    let offset    = 0;
    clips.slice().sort((a, b) => (a.word + a.voice).localeCompare(b.word + b.voice))
        .forEach(c => {
            entries.push({ word : c.word, voice : c.voice, gen : c.gen,
                           offset : offset, length : c.audio.length });
            chunks.push(c.audio);
            offset += c.audio.length;
        });
    const manifest = { format : 'empack', version : 2, part : span,
                       clipCount : entries.length, clips : entries };
    const mjson = Buffer.from(JSON.stringify(manifest), 'utf8');
    const head  = Buffer.alloc(12);
    head.write('EMPACK1\u0000', 0, 'binary');
    head.writeUInt32LE(mjson.length, 8);
    return Buffer.concat([head, mjson, Buffer.concat(chunks)]);
}

// A pre-split pack is STAMPED: its embedded manifest carries generation,
// voices and clipCount, and the v1 client path reads them from there rather
// than from the release manifest. A part deliberately has none of that, which
// is what keeps its sha256 stable, so the two need different builders.
function buildMonolith(clips, generation) {
    const raw = buildPart(clips, null);
    const len = raw.readUInt32LE(8);
    const man = JSON.parse(raw.slice(12, 12 + len).toString('utf8'));
    delete man.part;
    const stamped = Object.assign({
        format : 'empack', version : 1, generation : generation,
        createdAt : '2026-05-26T07:06:43Z', model : 'gpt-4o-mini-tts',
        voices : ['nova']
    }, { clipCount : man.clipCount, clips : man.clips });
    const mjson = Buffer.from(JSON.stringify(stamped), 'utf8');
    const head  = Buffer.alloc(12);
    head.write('EMPACK1\u0000', 0, 'binary');
    head.writeUInt32LE(mjson.length, 8);
    return Buffer.concat([head, mjson, raw.slice(12 + len)]);
}

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

function clip(word, voice) {
    return { word : word, voice : voice, gen : 1,
             audio : Buffer.from(word + '|' + voice + '|audio') };
}

// --- Harness -------------------------------------------------------------

function load() {
    const requests = [];
    const fdb = require('fake-indexeddb');
    const sandbox = {
        console : { log : () => {}, warn : () => {}, error : () => {} },
        setTimeout : setTimeout, clearTimeout : clearTimeout,
        indexedDB : new fdb.IDBFactory(),
        IDBKeyRange : fdb.IDBKeyRange,
        TextDecoder : TextDecoder, TextEncoder : TextEncoder,
        Blob : class Blob {
            constructor(parts) { this._b = Buffer.concat(parts.map(p => Buffer.from(p))); }
            get size() { return this._b.length; }
        },
        crypto : { subtle : require('crypto').webcrypto.subtle },
        Uint8Array : Uint8Array, DataView : DataView, JSON : JSON,
        Date : Date, Math : Math, Object : Object, Array : Array,
        String : String, Number : Number, Set : Set, Promise : Promise,
        URL : URL, Error : Error, encodeURIComponent : encodeURIComponent,
        __requests : requests, __assets : {}, __failOn : null
    };
    sandbox.self   = sandbox;
    sandbox.window = sandbox;
    sandbox.DB = { getPref : (n, f) => (n === 'tts_proxy_url' ? 'https://w.example' : f) };
    sandbox.fetch = (url, opts) => {
        const u    = String(url);
        const name = decodeURIComponent((u.match(/asset=([^&]+)/) || [])[1] || '');
        requests.push({ url : u, name : name, opts : opts || null });
        if (sandbox.__failOn && name === sandbox.__failOn) {
            return Promise.reject(new Error('network died'));
        }
        const body = sandbox.__assets[name];
        if (body === undefined) {
            return Promise.resolve({ ok : false, status : 404,
                                     text : () => Promise.resolve('nope') });
        }
        if (typeof body === 'object' && !Buffer.isBuffer(body)) {
            return Promise.resolve({ ok : true, status : 200,
                                     json : () => Promise.resolve(body) });
        }
        return Promise.resolve({
            ok : true, status : 200,
            headers : { get : k => (k === 'Content-Length' ? String(body.length) : null) },
            arrayBuffer : () => Promise.resolve(
                body.buffer.slice(body.byteOffset, body.byteOffset + body.length))
        });
    };
    const code = fs.readFileSync(path.join(__dirname, '..', 'tts-pack.js'), 'utf8');
    vm.runInNewContext(code, sandbox, { filename : 'tts-pack.js' });
    return sandbox;
}

// --- Fixtures ------------------------------------------------------------

const partA = buildPart([clip('alpha', 'nova'), clip('bravo', 'nova')], [1, 80]);
const partB = buildPart([clip('delta', 'nova'), clip('echo', 'nova')], [81, 160]);
const partB2 = buildPart([clip('delta', 'nova'), clip('echo', 'nova'),
                          clip('foxtrot', 'nova')], [81, 160]);

const NAME_A = 'empro-audio-pack.p00001-00080.empack';
const NAME_B = 'empro-audio-pack.p00081-00160.empack';
const MANIFEST = 'empro-audio-pack.manifest.json';

function manifest(parts, generation) {
    return {
        format : 'empack', version : 2, generation : generation,
        model : 'gpt-4o-mini-tts', voices : ['nova'], partBlocks : 80,
        partCount : parts.length,
        clipCount : parts.reduce((n, p) => n + p.clipCount, 0),
        parts : parts
    };
}
const recA  = { name : NAME_A, from : 1,  to : 80,  bytes : partA.length,
                sha256 : sha256(partA),  clipCount : 2, keysSha256 : 'ka' };
const recB  = { name : NAME_B, from : 81, to : 160, bytes : partB.length,
                sha256 : sha256(partB),  clipCount : 2, keysSha256 : 'kb' };
const recB2 = { name : NAME_B, from : 81, to : 160, bytes : partB2.length,
                sha256 : sha256(partB2), clipCount : 3, keysSha256 : 'kb2' };

// --- Tests ---------------------------------------------------------------

async function run() {
    // 1 + 6. First download.
    const s = load();
    s.__assets[MANIFEST] = manifest([recA, recB], 5);
    s.__assets[NAME_A]   = partA;
    s.__assets[NAME_B]   = partB;

    let res = await s.TTSPack.download(() => {});
    eq(res.parts, 2, 'both parts are reported');
    eq(res.updated, 2, 'both were imported');
    const fetched1 = s.__requests.filter(r => r.name.endsWith('.empack')).map(r => r.name);
    eq(fetched1.sort(), [NAME_A, NAME_B].sort(), 'both parts were fetched');

    const man = s.__requests.find(r => r.name === MANIFEST);
    ok(/[?&]t=\d+/.test(man.url), 'the manifest URL carries a cache-buster');
    eq(man.opts && man.opts.cache, 'no-store',
       'and is requested no-store \u2014 a cached manifest silently hides an update');
    const partReq = s.__requests.find(r => r.name === NAME_A && r.url.indexOf('&v=') > 0);
    ok(!!partReq, 'a part URL carries its sha so the edge can cache it safely');

    ok(!!(await s.TTSPack.getClip('alpha', 'nova')), 'a clip from part A is stored');
    ok(!!(await s.TTSPack.getClip('echo', 'nova')),  'a clip from part B is stored');
    const st = await s.TTSPack.status();
    eq(st.parts, 2, 'status reports 2 parts held');
    eq(st.generation, 5, 'and the generation');

    // 2. Nothing changed.
    s.__requests.length = 0;
    res = await s.TTSPack.download(() => {});
    ok(res.upToDate === true, 'a second run reports up to date');
    eq(s.__requests.filter(r => r.name.endsWith('.empack')).length, 0,
       'and fetches not one part');

    // 3. One part changed.
    s.__requests.length = 0;
    s.__assets[MANIFEST] = manifest([recA, recB2], 6);
    s.__assets[NAME_B]   = partB2;
    res = await s.TTSPack.download(() => {});
    eq(s.__requests.filter(r => r.name.endsWith('.empack')).map(r => r.name),
       [NAME_B], 'only the changed part is fetched');
    eq(res.updated, 1, 'one part updated');
    ok(!!(await s.TTSPack.getClip('foxtrot', 'nova')), 'its new clip is stored');

    // 4. Interrupted download resumes.
    const s2 = load();
    s2.__assets[MANIFEST] = manifest([recA, recB], 5);
    s2.__assets[NAME_A]   = partA;
    s2.__assets[NAME_B]   = partB;
    s2.__failOn = NAME_B;
    let threw = false;
    try { await s2.TTSPack.download(() => {}); } catch (e) { threw = true; }
    ok(threw, 'a failed part rejects rather than reporting success');
    ok(!!(await s2.TTSPack.getClip('alpha', 'nova')),
       'the part that did land is kept');
    eq((await s2.TTSPack.status()).parts, 1, 'and is recorded as held');

    s2.__failOn = null;
    s2.__requests.length = 0;
    res = await s2.TTSPack.download(() => {});
    eq(s2.__requests.filter(r => r.name.endsWith('.empack')).map(r => r.name),
       [NAME_B], 'the retry starts at the part that failed, not from scratch');
    ok(!!(await s2.TTSPack.getClip('echo', 'nova')), 'and finishes the job');

    // 5. Corrupted part is rejected.
    const s3 = load();
    const bad = Object.assign({}, recA, { sha256 : sha256(Buffer.from('other')) });
    s3.__assets[MANIFEST] = manifest([bad], 1);
    s3.__assets[NAME_A]   = partA;
    let msg = '';
    try { await s3.TTSPack.download(() => {}); } catch (e) { msg = e.message; }
    ok(/checksum/i.test(msg), 'a part failing its sha256 is refused');
    let stored = null;
    try { stored = await s3.TTSPack.getClip('alpha', 'nova'); } catch (e) { stored = null; }
    ok(!stored, 'and none of its clips are imported');

    // 7. A v1 manifest still works.
    const s4 = load();
    s4.__assets[MANIFEST] = { format : 'empack', version : 1, generation : 9,
                              voices : ['nova'], clipCount : 2 };
    s4.__assets['empro-audio-pack.empack'] =
        buildMonolith([clip('alpha', 'nova'), clip('bravo', 'nova')], 9);
    res = await s4.TTSPack.download(() => {});
    ok(res && res.generation === 9, 'a v1 manifest uses the monolithic path');
    ok(!!(await s4.TTSPack.getClip('alpha', 'nova')), 'and its clips import');

    console.log('\n' + '='.repeat(52));
    console.log(passed + ' passed, ' + failed + ' failed');
    console.log('='.repeat(52));
    process.exit(failed ? 1 : 0);
}

run().catch(e => {
    console.log('\nharness error: ' + e.stack);
    process.exit(1);
});
