/**
 * tts-pack.js - EMPro pre-generated pronunciation pack
 * ============================================================
 * Downloads a bundled pack of pre-generated word pronunciations and
 * stores it on the device, so playback of covered words needs no API
 * key, no proxy, and no live network.
 *
 * Storage
 *   A dedicated IndexedDB database, 'emp-tts-pack', kept separate from
 *   the 'emp-tts' live cache so that cache's size-based eviction can
 *   never delete a downloaded clip. Clips here are permanent until the
 *   word is removed or the pack is cleared.
 *
 * Download path
 *   The pack lives as a GitHub Release asset. Browsers cannot fetch
 *   Release assets directly - the download URL 302-redirects to a CDN
 *   blob that sends no CORS header. So the download is routed through
 *   the same Cloudflare Worker used for neural TTS, which fetches the
 *   asset server-side and adds the CORS header. The Worker URL is the
 *   'tts_proxy_url' preference set in Settings, Voice.
 *
 * Pack format
 *   8-byte magic "EMPACK1\0", uint32 LE manifest length, JSON manifest,
 *   then every clip's MP3 bytes concatenated. See tools/README.md.
 *
 * Public API (window.TTSPack)
 *   download(onStatus)      fetch + import the pack; onStatus(msg) for UI
 *   getClip(word, voice)    -> Promise<Blob|null>
 *   getCachedVoices(word)   -> Promise<string[]> voices present for a word
 *   playWord(text, onEnd)   -> Promise<boolean>; plays a random cached
 *                              voice; false if the word is not in the pack
 *   stop()                  stop any pack clip currently playing
 *   deleteWord(word)         remove every voice's clip for a word
 *   status()                -> Promise<{generation,clipCount,voices}|null>
 *   clear()                  wipe the whole pack store
 * ============================================================
 */
window.TTSPack = (function () {
    'use strict';

    // Release asset names proxied through the Worker.
    const FULL_ASSET     = 'empro-audio-pack.empack';
    const MANIFEST_ASSET = 'empro-audio-pack.manifest.json';

    const DB_NAME        = 'emp-tts-pack';   // separate DB, never evicted
    const STORE          = 'clips';
    const META_KEY       = '__meta__';       // meta record key; has no '|'
                                             // so it cannot collide with a
                                             // real 'voice|word' clip key
    const MAGIC          = 'EMPACK1\u0000';  // 8 bytes
    const IMPORT_CHUNK   = 200;              // clips per IndexedDB write tx

    // --- IndexedDB ---------------------------------------------------

    let _dbPromise = null;
    function db() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise((resolve, reject) => {
            let req;
            try { req = indexedDB.open(DB_NAME, 1); }
            catch (e) { return reject(e); }
            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains(STORE)) {
                    d.createObjectStore(STORE, { keyPath: 'k' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
        return _dbPromise;
    }

    function idbGet(key) {
        return db().then(d => new Promise((resolve) => {
            const rq = d.transaction(STORE, 'readonly')
                        .objectStore(STORE).get(key);
            rq.onsuccess = () => resolve(rq.result || null);
            rq.onerror   = () => resolve(null);
        }));
    }

    function idbAllKeys() {
        return db().then(d => new Promise((resolve) => {
            const rq = d.transaction(STORE, 'readonly')
                        .objectStore(STORE).getAllKeys();
            rq.onsuccess = () => resolve(rq.result || []);
            rq.onerror   = () => resolve([]);
        }));
    }

    function idbPutMany(records) {
        return db().then(d => new Promise((resolve, reject) => {
            const tx = d.transaction(STORE, 'readwrite');
            const os = tx.objectStore(STORE);
            records.forEach(r => os.put(r));
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        }));
    }

    function idbDeleteKeys(keys) {
        return db().then(d => new Promise((resolve) => {
            const tx = d.transaction(STORE, 'readwrite');
            const os = tx.objectStore(STORE);
            keys.forEach(k => os.delete(k));
            tx.oncomplete = () => resolve();
            tx.onerror    = () => resolve();
        }));
    }

    // --- Key helpers -------------------------------------------------

    // Words are matched case-insensitively; the pack stores them lowercased.
    function norm(word)            { return String(word || '').trim().toLowerCase(); }
    function clipKey(word, voice)  { return voice + '|' + norm(word); }

    // --- Pack parsing ------------------------------------------------

    // Parse a .empack ArrayBuffer into a manifest and an array of clips,
    // each { word, voice, blob }. Throws on a bad magic header.
    function parsePack(buf) {
        const bytes = new Uint8Array(buf);
        const magic = new TextDecoder().decode(bytes.subarray(0, 8));
        if (magic !== MAGIC) throw new Error('not an EMPACK1 file');

        const dv       = new DataView(buf);
        const mLen     = dv.getUint32(8, true);
        const manifest = JSON.parse(
            new TextDecoder().decode(bytes.subarray(12, 12 + mLen)));
        const dataStart = 12 + mLen;

        const clips = (manifest.clips || []).map(c => ({
            word : norm(c.word),
            voice: c.voice,
            blob : new Blob(
                [buf.slice(dataStart + c.offset,
                           dataStart + c.offset + c.length)],
                { type: 'audio/mpeg' }),
        }));
        return { manifest: manifest, clips: clips };
    }

    // --- Worker URL --------------------------------------------------

    function workerBase() {
        const u = (window.DB && window.DB.getPref
                   ? window.DB.getPref('tts_proxy_url', '') : '') || '';
        return u.trim().replace(/\/+$/, '');   // strip any trailing slash
    }

    function assetUrl(base, asset) {
        return base + '?asset=' + encodeURIComponent(asset);
    }

    // --- Download with progress -------------------------------------

    async function fetchWithProgress(url, onProgress) {
        const resp = await fetch(url);
        if (!resp.ok) {
            let detail = '';
            try { detail = (await resp.text()).slice(0, 200); } catch (e) { /* ignore */ }
            throw new Error('HTTP ' + resp.status + (detail ? ' \u2014 ' + detail : ''));
        }

        const total = Number(resp.headers.get('Content-Length')) || 0;
        if (!resp.body || !resp.body.getReader) {
            return new Uint8Array(await resp.arrayBuffer());
        }

        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
            const step = await reader.read();
            if (step.done) break;
            chunks.push(step.value);
            received += step.value.length;
            if (onProgress) onProgress(received, total);
        }

        const out = new Uint8Array(received);
        let offset = 0;
        for (const c of chunks) { out.set(c, offset); offset += c.length; }
        return out;
    }

    // --- Public: download -------------------------------------------

    async function download(onStatus) {
        const say  = (m) => { if (typeof onStatus === 'function') onStatus(m); };
        const base = workerBase();
        if (!base) {
            throw new Error('Set your Cloudflare Worker URL first - it is '
                          + 'the TTS proxy URL in the Neural voice section.');
        }

        // 1. Manifest check - skip the large download if already current.
        try {
            say('Checking for updates\u2026');
            const mResp = await fetch(assetUrl(base, MANIFEST_ASSET));
            if (mResp.ok) {
                const remote = await mResp.json();
                const meta   = await idbGet(META_KEY);
                if (meta && meta.generation === remote.generation) {
                    say('Already up to date \u2014 generation '
                        + remote.generation + ', '
                        + meta.clipCount + ' clip(s).');
                    return { upToDate: true, generation: remote.generation };
                }
            }
        } catch (e) {
            // The manifest is only an optimisation; on any failure just
            // fall through and download the full pack.
            console.warn('[pack] manifest check skipped:', e && e.message);
        }

        // 2. Download the full pack.
        say('Downloading\u2026');
        const raw = await fetchWithProgress(
            assetUrl(base, FULL_ASSET),
            (recv, total) => {
                say(total
                    ? 'Downloading\u2026 ' + Math.floor(recv / total * 100) + '%'
                    : 'Downloading\u2026 ' + (recv / 1048576).toFixed(1) + ' MB');
            });

        // 3. Parse.
        say('Unpacking\u2026');
        const parsed   = parsePack(raw.buffer);
        const manifest = parsed.manifest;

        // 4. Import - store only clips not already present, so a repeat
        //    download after a small change costs almost no work.
        const existing = new Set(await idbAllKeys());
        const fresh = parsed.clips
            .filter(c => !existing.has(clipKey(c.word, c.voice)))
            .map(c => ({ k: clipKey(c.word, c.voice), blob: c.blob }));
        if (fresh.length) {
            say('Saving ' + fresh.length + ' clip(s)\u2026');
            for (let i = 0; i < fresh.length; i += IMPORT_CHUNK) {
                await idbPutMany(fresh.slice(i, i + IMPORT_CHUNK));
            }
        }

        // 5. Record the meta row.
        await idbPutMany([{
            k         : META_KEY,
            generation: manifest.generation,
            voices    : manifest.voices || [],
            clipCount : manifest.clipCount || parsed.clips.length,
            importedAt: Date.now(),
        }]);

        say('Done \u2014 generation ' + manifest.generation + ', '
            + (manifest.clipCount || parsed.clips.length) + ' clip(s), '
            + (manifest.voices || []).length + ' voice(s).');
        return {
            generation: manifest.generation,
            clipCount : manifest.clipCount || parsed.clips.length,
            imported  : fresh.length,
        };
    }

    // --- Public: lookups --------------------------------------------

    async function getClip(word, voice) {
        const rec = await idbGet(clipKey(word, voice));
        return rec ? rec.blob : null;
    }

    // Which of the pack's voices have a clip for this word.
    async function getCachedVoices(word) {
        const meta = await idbGet(META_KEY);
        if (!meta || !meta.voices) return [];
        const w     = norm(word);
        const found = [];
        for (const v of meta.voices) {
            const rec = await idbGet(v + '|' + w);
            if (rec) found.push(v);
        }
        return found;
    }

    // Compare a word list against the installed pack. A word counts as
    // covered if at least one voice has a clip for it. Returns counts
    // plus the list of words that have no audio yet.
    async function coverage(words) {
        const keys = await idbAllKeys();
        const have = new Set();
        for (const k of keys) {
            if (k === META_KEY) continue;
            const bar = k.indexOf('|');
            if (bar > 0) have.add(k.slice(bar + 1));
        }
        const seen    = new Set();
        const missing = [];
        for (const w of (words || [])) {
            const n = norm(w);
            if (!n || seen.has(n)) continue;
            seen.add(n);
            if (!have.has(n)) missing.push(n);
        }
        return {
            total       : seen.size,
            covered     : seen.size - missing.length,
            missing     : missing.length,
            missingWords: missing,
        };
    }

    // --- Public: playback -------------------------------------------

    let _audio = null;

    function stop() {
        try {
            if (_audio) {
                _audio.pause();
                _audio.onended = null;
                _audio.onerror = null;
                if (_audio.src) URL.revokeObjectURL(_audio.src);
                _audio = null;
            }
        } catch (e) { /* ignore */ }
    }

    // Play one word from the pack. preferredVoices, when given, restricts
    // the random pick to the user's chosen voices; if none of those are
    // cached for this word, any cached voice is used so offline audio is
    // never wasted. A voice is picked at random each call, so the same
    // word sounds different on repeat at no network cost. Pack clips are
    // pre-rendered at a model learner pace and play at natural speed.
    // Resolves true if it played, false if the word is not in the pack
    // (the caller then falls back to the live or device voice).
    async function playWord(text, preferredVoices, onEnd) {
        const cached = await getCachedVoices(text);
        if (!cached.length) {
            const meta = await idbGet(META_KEY);
            console.log('[pack] MISS ' + JSON.stringify(norm(text)) + ' \u2014 '
                + (meta ? ('pack has ' + meta.clipCount
                           + ' clip(s) but not this word')
                        : 'no pack installed') + '; falling back');
            return false;
        }

        let pool = cached;
        if (Array.isArray(preferredVoices) && preferredVoices.length) {
            const want     = new Set(preferredVoices.map(v => String(v).toLowerCase()));
            const narrowed = cached.filter(v => want.has(v));
            if (narrowed.length) pool = narrowed;
        }
        const voice = pool[Math.floor(Math.random() * pool.length)];
        const blob  = await getClip(text, voice);
        if (!blob) {
            console.log('[pack] MISS ' + JSON.stringify(norm(text))
                + ' \u2014 clip blob missing for voice ' + voice);
            return false;
        }
        console.log('[pack] HIT ' + JSON.stringify(norm(text)) + ' \u2014 voice '
            + voice + ' (cached: ' + cached.join(',') + ')');

        stop();
        const url   = URL.createObjectURL(blob);
        const audio = new Audio(url);
        _audio = audio;

        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            if (_audio === audio) _audio = null;
            try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
            if (typeof onEnd === 'function') onEnd();
        };
        audio.onended = finish;
        audio.onerror = finish;
        try { await audio.play(); }
        catch (e) {
            console.log('[pack] audio.play() rejected: ' + (e && e.message));
            finish();
        }
        return true;
    }

    // --- Public: maintenance ----------------------------------------

    // Remove every voice's clip for a word. Called when a vocabulary
    // word is deleted, so orphaned pack audio does not accumulate.
    async function deleteWord(word) {
        const meta   = await idbGet(META_KEY);
        const voices = (meta && meta.voices) || [];
        const w      = norm(word);
        const keys   = voices.map(v => v + '|' + w);
        if (keys.length) await idbDeleteKeys(keys);
    }

    async function status() {
        const meta = await idbGet(META_KEY);
        if (!meta) return null;
        return {
            generation: meta.generation,
            clipCount : meta.clipCount,
            voices    : meta.voices || [],
            importedAt: meta.importedAt,
        };
    }

    async function clear() {
        const d = await db();
        await new Promise((resolve) => {
            const tx = d.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).clear();
            tx.oncomplete = resolve;
            tx.onerror    = resolve;
        });
    }

    return {
        download       : download,
        getClip        : getClip,
        getCachedVoices: getCachedVoices,
        coverage       : coverage,
        playWord       : playWord,
        stop           : stop,
        deleteWord     : deleteWord,
        status         : status,
        clear          : clear,
    };
})();
