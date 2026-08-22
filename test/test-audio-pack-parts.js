/**
 * test-audio-pack-parts.js - audio pack part-splitting test suite (v99)
 * ============================================================
 * Verifies the split-pack pipeline end to end:
 *
 *   Static     version-number discipline (sw.js / index.html), workflow
 *              publishes parts + cleans stale assets, generator and
 *              client carry the part logic.
 *   Generator  python --selftest (format round-trip, block-boundary
 *              splitting, earlier-part sha256 stability).
 *   Client     tts-pack.js runs in Node against real packs built by the
 *              python generator: first download imports every part;
 *              an immediate re-download is a no-op; after a new word is
 *              appended, ONLY the changed part is fetched again.
 *
 * Run:  node test-audio-pack-parts.js
 * Needs: fake-indexeddb  (npm i fake-indexeddb)
 * Lives in <repo>/test/; reads app files from the repo root.
 * Run from anywhere: node test/test-audio-pack-parts.js
 * ============================================================
 */
'use strict';

const fs            = require('fs');
const path          = require('path');
const crypto        = require('crypto');
const { execSync }  = require('child_process');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log('  ok  ' + name); }
    else      { failed++; console.log('FAIL  ' + name + (detail ? ' - ' + detail : '')); }
}

const ROOT   = path.join(__dirname, '..');   // tests live in <repo>/test/
const read   = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// --- 1. Static consistency ---------------------------------------

console.log('[static]');
const sw    = read('sw.js');
const html  = read('index.html');
const yml   = read('.github/workflows/audio-pack.yml');
const py    = read('tools/generate_audio_pack.py');
const packJ = read('tts-pack.js');

check('sw.js CACHE_NAME is emp-v101', sw.includes("const CACHE_NAME = 'emp-v101';"));
const vNew = (html.match(/\?v=101/g) || []).length;
const vOld = (html.match(/\?v=(9[89]|100)"/g) || []).length;
check('index.html has 19 x ?v=101 and no stale versions', vNew === 19 && vOld === 0,
      vNew + ' new, ' + vOld + ' old');

check('workflow publishes part glob',
      yml.includes('tools/dist/empro-audio-pack.part*.empack'));
check('workflow no longer publishes the delta',
      !yml.includes('empro-audio-pack.delta.empack'));
check('workflow cleanup is guarded on the manifest existing',
      yml.includes('empro-audio-pack.manifest.json ]'));
check('workflow deletes stale assets via gh',
      yml.includes('gh release delete-asset audio-pack'));

check('generator has split_parts', py.includes('def split_parts('));
check('generator writes per-part sha256', py.includes('hashlib.sha256(pbytes)'));
check('generator part manifests are unstamped', py.includes('stamp=False'));

check('client fetches manifest with no-store + timestamp',
      packJ.includes("{ cache: 'no-store' }") && packJ.includes("'&t=' + Date.now()"));
check('client has the parts download path', packJ.includes('function downloadParts('));
check('client verifies part sha256', packJ.includes('sha256Hex(raw)'));

// --- 2. Generator selftest ----------------------------------------

console.log('[generator]');
let selftestOut = '';
try {
    selftestOut = execSync('python3 tools/generate_audio_pack.py --selftest',
                           { cwd: ROOT, encoding: 'utf8' });
} catch (e) {
    selftestOut = String((e.stdout || '') + (e.stderr || ''));
}
check('python --selftest passes', selftestOut.includes('[selftest] OK'),
      selftestOut.trim().split('\n').pop());

// --- 3. Build two real fixture generations with the generator -----

// Uses the generator's own split_parts / build_pack via a python helper,
// mirroring exactly what run_build writes (parts + v2 manifest). Gen A has
// 3 word blocks under a tiny cap (forcing 2+ parts); gen B appends one
// block, which must only touch the final part.
console.log('[fixtures]');
const FIX = path.join(__dirname, 'test-fixtures');
fs.rmSync(FIX, { recursive: true, force: true });
fs.mkdirSync(path.join(FIX, 'a'), { recursive: true });
fs.mkdirSync(path.join(FIX, 'b'), { recursive: true });

const helper = `
import sys, os, json, random, hashlib
sys.argv = ["tools/generate_audio_pack.py", "--selftest"]  # safe entry on import
import importlib.util
spec = importlib.util.spec_from_file_location("gen", "tools/generate_audio_pack.py")
gen  = importlib.util.module_from_spec(spec)
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(gen)          # runs --selftest quietly

random.seed(7)
VOICES = ["fable", "nova"]

def clips_for(words, g):
    out = {}
    for w in words:
        for v in VOICES:
            out[(w, v)] = {"gen": g,
                           "audio": bytes(random.getrandbits(8)
                                          for _ in range(random.randint(4000, 9000)))}
    return out

def write_dist(dist, blocks, combined, gen_no):
    os.makedirs(dist, exist_ok=True)
    parts = gen.split_parts(blocks, combined, 24000)
    infos = []
    total = 0
    for i, plist in enumerate(parts, start=1):
        pg          = max(c["gen"] for c in plist)
        pbytes, pm  = gen.build_pack(plist, VOICES, pg, "test-model", stamp=False)
        name        = gen.part_name(i)
        open(os.path.join(dist, name), "wb").write(pbytes)
        total      += pm["clipCount"]
        infos.append({"name": name, "clipCount": pm["clipCount"],
                      "size": len(pbytes),
                      "sha256": hashlib.sha256(pbytes).hexdigest()})
    manifest = {"format": "empack", "version": 2, "generation": gen_no,
                "createdAt": "2026-01-01T00:00:00Z", "model": "test-model",
                "voices": VOICES, "clipCount": total,
                "partSizeMB": 1, "partCount": len(infos), "parts": infos}
    open(os.path.join(dist, "empro-audio-pack.manifest.json"), "w").write(
        json.dumps(manifest))

words_a  = ["ubiquitous", "ephemeral", "salient"]
blocks_a = [{"index": i + 1, "entries": [w]} for i, w in enumerate(words_a)]
comb_a   = clips_for(words_a, 1)
write_dist(os.path.join("test", "test-fixtures", "a"), blocks_a, comb_a, 1)

blocks_b = blocks_a + [{"index": 4, "entries": ["perennial"]}]
comb_b   = dict(comb_a)
comb_b.update(clips_for(["perennial"], 2))
write_dist(os.path.join("test", "test-fixtures", "b"), blocks_b, comb_b, 2)
print("fixtures written")
`;
let fixOut = '';
try {
    fixOut = execSync('python3 -', { cwd: ROOT, input: helper, encoding: 'utf8' });
} catch (e) {
    fixOut = String((e.stdout || '') + (e.stderr || ''));
}
check('fixture generations built', fixOut.includes('fixtures written'), fixOut.trim());

const manA = JSON.parse(read('test/test-fixtures/a/empro-audio-pack.manifest.json'));
const manB = JSON.parse(read('test/test-fixtures/b/empro-audio-pack.manifest.json'));
check('gen A split into multiple parts', manA.parts.length >= 2,
      manA.parts.length + ' part(s)');
const shared    = Math.min(manA.parts.length, manB.parts.length) - 1;
const stableOk  = manA.parts.slice(0, shared).every(
    (p, i) => p.sha256 === manB.parts[i].sha256);
check('appending a word kept earlier part hashes stable', stableOk);
const changedB  = manB.parts.filter(
    (p) => !manA.parts.some((q) => q.name === p.name && q.sha256 === p.sha256));
check('exactly one part changed or was added in gen B', changedB.length === 1,
      changedB.map(p => p.name).join(','));

// --- 4. Run tts-pack.js in Node against the fixtures --------------

console.log('[client]');
require('fake-indexeddb/auto');            // provides global indexedDB

global.window = global;                     // the IIFE attaches to window
window.DB = { getPref: (k, d) => (k === 'tts_proxy_url' ? 'https://worker.test' : d) };

let fetchRoot = path.join(FIX, 'a');
const fetchedAssets = [];
global.fetch = async (url) => {
    const u     = new URL(url);
    const asset = u.searchParams.get('asset');
    fetchedAssets.push(asset);
    const file  = path.join(fetchRoot, asset);
    if (!fs.existsSync(file)) return { ok: false, status: 404, text: async () => 'missing' };
    const buf = fs.readFileSync(file);
    const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return {
        ok     : true,
        status : 200,
        headers: { get: (h) => (h === 'Content-Length' ? String(buf.length) : null) },
        body   : null,                      // fetchWithProgress falls back to arrayBuffer()
        json       : async () => JSON.parse(buf.toString('utf8')),
        arrayBuffer: async () => ab,
        text       : async () => buf.toString('utf8'),
    };
};

// eslint-disable-next-line no-eval
eval(read('tts-pack.js'));                  // defines window.TTSPack

(async () => {
    const isPart = (a) => a && a.startsWith('empro-audio-pack.part');

    // First download: every gen-A part imported.
    const r1 = await TTSPack.download(() => {});
    check('first download imports all gen A clips',
          r1.imported === manA.clipCount && r1.generation === 1,
          JSON.stringify(r1));
    const clip = await TTSPack.getClip('ubiquitous', 'fable');
    check('clip retrievable after import', !!clip && clip.size > 0);
    const st1 = await TTSPack.status();
    check('status reports part count', st1.partCount === manA.parts.length,
          JSON.stringify(st1));

    // Second download: no part fetched, reported up to date.
    fetchedAssets.length = 0;
    const r2 = await TTSPack.download(() => {});
    check('re-download is a no-op', r2.upToDate === true
          && fetchedAssets.filter(isPart).length === 0,
          'fetched: ' + fetchedAssets.join(','));

    // Gen B published: only the changed/added part is fetched.
    fetchRoot = path.join(FIX, 'b');
    fetchedAssets.length = 0;
    const r3       = await TTSPack.download(() => {});
    const partHits = fetchedAssets.filter(isPart);
    check('gen B fetches exactly the one changed part',
          partHits.length === 1 && partHits[0] === changedB[0].name,
          'fetched: ' + partHits.join(','));
    check('gen B imported only that part\'s clips',
          r3.imported === changedB[0].clipCount && r3.generation === 2,
          JSON.stringify(r3));
    const clipNew = await TTSPack.getClip('perennial', 'nova');
    check('new word playable from the changed part', !!clipNew && clipNew.size > 0);
    const clipOld = await TTSPack.getClip('ephemeral', 'fable');
    check('earlier words untouched', !!clipOld && clipOld.size > 0);

    console.log('\n%d passed, %d failed', passed, failed);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
});
