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
 * Split packs (manifest v2)
 *   The pack is published as several parts, each cut on word-block
 *   boundaries, plus a small manifest listing every part with its
 *   sha256. Only the parts whose hash differs from this device's copy
 *   are downloaded, each is verified against its hash, and each is
 *   recorded as soon as it is imported - so an interrupted download
 *   resumes at the next part instead of starting the 1.4 GB again.
 *   A v1 manifest (one monolithic asset) still works, so a device is
 *   never stranded by a release that has not been rebuilt yet.
 *
 * Pack format
 *   8-byte magic "EMPACK1\0", uint32 LE manifest length, JSON manifest,
 *   then every clip's MP3 bytes concatenated. See tools/README.md.
 *
 * Public API (window.TTSPack)
 *   download(onStatus)      fetch + import the pack; onStatus(msg) for UI
 *   getClip(word, voice)    -> Promise<Blob|null>
 *   getCachedVoices(word)   -> Promise<string[]> voices present for a word
 *   playWord(text, preferredVoices, onEnd)
 *                           -> Promise<boolean>; plays a random cached
 *                              voice (restricted to preferredVoices when
 *                              given); false if the word is not in the pack
 *   stop()                  stop any pack clip currently playing
 *   deleteWord(word)         remove every voice's clip for a word
 *   status()                -> Promise<{generation,clipCount,voices}|null>
 *   clear()                  wipe the whole pack store
 * ============================================================
 */
window.TTSPack = (function () {
    'use strict';

    // Release asset names proxied through the Worker.
    const FULL_ASSET     = 'empro-audio-pack.empack';        // pre-split (v1)
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

    // Words/phrases are matched case-insensitively; the pack stores them
    // lowercased. Internal whitespace is collapsed too, matching the
    // generator's normalisation (\" \".join(text.split())), so a key built
    // from a multi-word collocation or a sentence resolves the same on
    // both sides regardless of stray double spaces.
    function norm(word)            { return String(word || '').trim().toLowerCase().replace(/\s+/g, ' '); }
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

    // --- Integrity ---------------------------------------------------

    function toHex(buf) {
        const b = new Uint8Array(buf);
        let out = '';
        for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
        return out;
    }

    // Verifies a downloaded part against the sha256 in the manifest.
    // Returns true when it matches, false when it does not, and null when the
    // device cannot hash at all — an insecure context or an old WebView with
    // no SubtleCrypto. A null is treated as "accept and log": refusing would
    // leave those devices with no audio whatsoever, which is worse than
    // trusting a transfer that has already survived TLS and Content-Length.
    async function verifySha256(bytes, expected) {
        if (!expected || !self.crypto || !self.crypto.subtle) return null;
        try {
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return toHex(digest) === String(expected).toLowerCase();
        } catch (e) {
            console.warn('[pack] cannot hash on this device:', e && e.message);
            return null;
        }
    }

    // The manifest must never come from a cache. The Worker sends it
    // no-store, and the timestamp defeats any intermediate that ignores
    // that: a stale manifest means the app decides it is up to date and a
    // real update is skipped, which is silent and lasts until the next
    // change.
    async function fetchManifest(base) {
        const url  = assetUrl(base, MANIFEST_ASSET) + '&t=' + Date.now();
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) throw new Error('manifest HTTP ' + resp.status);
        return resp.json();
    }

    // --- Public: download -------------------------------------------

    // Split-pack download (manifest v2). Only the parts whose sha256 differs
    // from the copy on this device are fetched, and each one is recorded the
    // moment it is imported — so a download interrupted at part 5 of 8 keeps
    // the first four and resumes at the fifth. On a 1.4 GB pack over a
    // domestic mobile connection that difference is the whole feature.
    async function downloadParts(base, manifest, say) {
        const parts = (manifest.parts || []).filter(p => p && p.name);
        if (!parts.length) throw new Error('manifest v2 lists no parts');

        const meta = (await idbGet(META_KEY)) || {};
        const have = Object.assign({}, meta.parts || {});
        const todo = parts.filter(p => have[p.name] !== p.sha256);

        const writeMeta = (extra) => idbPutMany([Object.assign({
            k         : META_KEY,
            generation: manifest.generation,
            voices    : manifest.voices || [],
            clipCount : manifest.clipCount || 0,
            partBlocks: manifest.partBlocks || 0,
            parts     : have,
            importedAt: Date.now(),
        }, extra || {})]);

        if (!todo.length) {
            await writeMeta();
            say('Already up to date \u2014 generation ' + manifest.generation
                + ', ' + parts.length + ' part(s), '
                + (manifest.clipCount || 0) + ' clip(s).');
            return { upToDate: true, generation: manifest.generation };
        }

        const totalMb = todo.reduce((n, p) => n + (p.bytes || 0), 0) / 1048576;
        say(todo.length + ' of ' + parts.length + ' part(s) changed \u2014 '
            + totalMb.toFixed(0) + ' MB to fetch.');

        let imported = 0;
        let done     = 0;
        for (const p of todo) {
            done++;
            const label = 'Part ' + done + '/' + todo.length;
            // The sha in the URL makes a part's address content-addressed, so
            // the edge can cache it safely and a changed part is never served
            // from a stale entry.
            const url = assetUrl(base, p.name) + '&v=' + String(p.sha256).slice(0, 16);
            const raw = await fetchWithProgress(url, (recv, total) => {
                const pct = total ? Math.floor(recv / total * 100)
                                  : Math.floor(recv / (p.bytes || 1) * 100);
                say(label + ' \u2014 ' + Math.min(99, pct) + '%');
            });

            const okHash = await verifySha256(raw, p.sha256);
            if (okHash === false) {
                throw new Error(p.name + ' failed its checksum \u2014 the '
                              + 'download was corrupted or the release changed '
                              + 'mid-download. Nothing was saved from it; try '
                              + 'again.');
            }
            if (okHash === null) {
                console.log('[pack] ' + p.name + ' not verified (no SubtleCrypto)');
            }

            say(label + ' \u2014 unpacking\u2026');
            const parsed   = parsePack(raw.buffer);
            const existing = new Set(await idbAllKeys());
            const fresh    = parsed.clips
                .filter(c => !existing.has(clipKey(c.word, c.voice)))
                .map(c => ({ k: clipKey(c.word, c.voice), blob: c.blob }));

            try {
                for (let i = 0; i < fresh.length; i += IMPORT_CHUNK) {
                    await idbPutMany(fresh.slice(i, i + IMPORT_CHUNK));
                }
            } catch (e) {
                // Out of quota is the realistic failure on a tablet. Say which
                // part stopped it and keep everything already imported: the
                // parts recorded so far stay valid and a retry resumes here.
                await writeMeta();
                throw new Error('Ran out of storage while saving ' + p.name
                              + ' (' + (e && e.message || 'quota exceeded')
                              + '). ' + imported + ' part(s) were saved and '
                              + 'will not be downloaded again.');
            }
            imported += 1;

            // Recorded per part, immediately. This is what makes the download
            // resumable rather than all-or-nothing.
            have[p.name] = p.sha256;
            await writeMeta();
        }

        await writeMeta();
        say('Done \u2014 generation ' + manifest.generation + ', '
            + imported + ' part(s) updated, ' + (manifest.clipCount || 0)
            + ' clip(s) in the pack.');
        return {
            generation: manifest.generation,
            clipCount : manifest.clipCount || 0,
            parts     : parts.length,
            updated   : imported,
        };
    }

    async function download(onStatus) {
        const say  = (m) => { if (typeof onStatus === 'function') onStatus(m); };
        const base = workerBase();
        if (!base) {
            throw new Error('Set your Cloudflare Worker URL first - it is '
                          + 'the TTS proxy URL in the Neural voice section.');
        }

        // 1. Read the manifest. For a v2 (split) pack this is not an
        //    optimisation but the index the whole download turns on, so a
        //    failure here is reported rather than swallowed.
        let remote = null;
        try {
            say('Checking for updates\u2026');
            remote = await fetchManifest(base);
        } catch (e) {
            console.warn('[pack] manifest read failed:', e && e.message);
        }

        if (remote && remote.version >= 2 && Array.isArray(remote.parts)) {
            return downloadParts(base, remote, say);
        }

        // 2. Pre-split pack (v1): one asset, all or nothing. Kept so a device
        //    still works against a release that has not been rebuilt yet.
        if (remote) {
            const meta = await idbGet(META_KEY);
            if (meta && meta.generation === remote.generation && !meta.parts) {
                say('Already up to date \u2014 generation '
                    + remote.generation + ', ' + meta.clipCount + ' clip(s).');
                return { upToDate: true, generation: remote.generation };
            }
        }

        say('Downloading the whole pack (pre-split release)\u2026');
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

    // One persistent <audio> element, created on the first play and
    // reused for every clip after that (only src changes). This is the
    // key to lock-screen playback: the browser treats it as one
    // continuous media session, so ended -> new src -> play() keeps
    // working with the screen off, whereas a fresh new Audio() started
    // in the background is rejected by the autoplay policy.
    let _audio    = null;
    let _playing  = false;
    let _watchdog = null;

    function ensureAudio() {
        if (!_audio) {
            _audio = new Audio();
            _audio.preload = 'auto';
        }
        return _audio;
    }

    function clearWatchdog() {
        if (_watchdog) { clearTimeout(_watchdog); _watchdog = null; }
    }

    // Pause and neutralise handlers WITHOUT touching the current src:
    // used between clips, where the old blob URL must stay alive until
    // the next load has replaced it (revoking a URL the element still
    // references is exactly the kind of thing that swallows events).
    function detach() {
        clearWatchdog();
        if (!_audio) return;
        try { _audio.pause(); } catch (e) { /* ignore */ }
        _audio.onended          = null;
        _audio.onerror          = null;
        _audio.onloadedmetadata = null;
    }

    function stop() {
        try {
            _playing = false;
            detach();
            if (_audio && _audio.src) {
                URL.revokeObjectURL(_audio.src);
                _audio.removeAttribute('src');
                try { _audio.load(); } catch (e) { /* release the pipeline */ }
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
    // Pick one cached clip blob for a text, honouring the preferred
    // voices like playWord does. Returns a Blob or null. Used by the
    // background "tape" builder, which concatenates whole groups into
    // one continuous stream.
    async function pickClip(text, preferredVoices) {
        const cached = await getCachedVoices(text);
        if (!cached.length) return null;
        let pool = cached;
        if (Array.isArray(preferredVoices) && preferredVoices.length) {
            const want     = new Set(preferredVoices.map(v => String(v).toLowerCase()));
            const narrowed = cached.filter(v => want.has(v));
            if (narrowed.length) pool = narrowed;
        }
        const voice = pool[Math.floor(Math.random() * pool.length)];
        return getClip(text, voice);
    }

    // Play one long blob (a concatenated group) on the persistent
    // element. Background-proof by construction: a single play() with
    // no src switches until it ends. Returns { seek, stop }; onTime
    // fires on timeupdate with (currentTime, duration).
    function playTape(blob, onTime, onEnd) {
        detach();
        const audio   = ensureAudio();
        const prevSrc = audio.src || '';
        const url     = URL.createObjectURL(blob);
        _playing      = true;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            _playing = false;
            clearWatchdog();
            audio.ontimeupdate = null;
            try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
            if (typeof onEnd === 'function') onEnd();
        };
        audio.onended      = finish;
        audio.onerror      = finish;
        audio.ontimeupdate = () => {
            if (typeof onTime === 'function') {
                onTime(audio.currentTime || 0, audio.duration || 0);
            }
        };
        audio.src = url;
        if (prevSrc && prevSrc.startsWith('blob:')) {
            try { URL.revokeObjectURL(prevSrc); } catch (e) { /* ignore */ }
        }
        audio.play().catch(e => {
            console.log('[pack] tape play() rejected: ' + (e && e.message));
            finish();
        });
        return {
            seek: (frac) => {
                try {
                    if (isFinite(audio.duration) && audio.duration > 0) {
                        audio.currentTime =
                            Math.max(0, Math.min(0.999, frac)) * audio.duration;
                    }
                } catch (e) { /* ignore */ }
            },
            stop: () => { done = true; _playing = false; clearWatchdog();
                          audio.ontimeupdate = null;
                          try { audio.pause(); } catch (e) {}
                          try { URL.revokeObjectURL(url); } catch (e) {} },
        };
    }

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

        detach();                       // old URL stays alive until replaced
        const audio   = ensureAudio();
        const prevSrc = audio.src || '';
        const url     = URL.createObjectURL(blob);
        _playing      = true;

        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            _playing = false;
            clearWatchdog();
            try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
            if (typeof onEnd === 'function') onEnd();
        };
        audio.onended = finish;
        audio.onerror = finish;
        // Duration-based watchdog: whichever browser quirk swallows the
        // ended event, the sequence advances anyway instead of stalling.
        audio.onloadedmetadata = () => {
            clearWatchdog();
            const secs = (isFinite(audio.duration) && audio.duration > 0)
                       ? audio.duration : 30;
            _watchdog = setTimeout(() => {
                console.log('[pack] watchdog advanced past '
                            + JSON.stringify(norm(text)));
                finish();
            }, secs * 1000 + 3000);
        };
        audio.src = url;                // load algorithm detaches the old one
        if (prevSrc) {
            try { URL.revokeObjectURL(prevSrc); } catch (e) { /* ignore */ }
        }
        try {
            await audio.play();
            if (!done && !_watchdog) _watchdog = setTimeout(finish, 33000);
        } catch (e) {
            console.log('[pack] audio.play() rejected: ' + (e && e.message));
            finish();
        }
        return true;
    }

    // A generated silent WAV, played through the SAME persistent
    // element so it never stops sounding between clips. This is the
    // load-bearing piece of lock-screen playback: with timer-based
    // silent gaps, locking the screen during a gap let the OS take
    // audio focus away and refuse the next play(); with real (silent)
    // audio in the gaps, the media session stays continuously active.
    const _silence = {};                 // ms -> data URI, built once

    function silenceUri(ms) {
        if (_silence[ms]) return _silence[ms];
        const rate    = 8000;
        const samples = Math.max(1, Math.round(rate * ms / 1000));
        const size    = 44 + samples;                 // 8-bit mono PCM
        const buf     = new Uint8Array(size);
        const dv      = new DataView(buf.buffer);
        const str     = (o, s) => { for (let i = 0; i < s.length; i++)
                                        buf[o + i] = s.charCodeAt(i); };
        str(0, 'RIFF'); dv.setUint32(4, size - 8, true); str(8, 'WAVE');
        str(12, 'fmt '); dv.setUint32(16, 16, true);
        dv.setUint16(20, 1, true);  dv.setUint16(22, 1, true);
        dv.setUint32(24, rate, true); dv.setUint32(28, rate, true);
        dv.setUint16(32, 1, true);  dv.setUint16(34, 8, true);
        str(36, 'data'); dv.setUint32(40, samples, true);
        buf.fill(0x80, 44);                           // 8-bit silence
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        _silence[ms] = 'data:audio/wav;base64,' + btoa(bin);
        return _silence[ms];
    }

    // Play ms of silence, then onEnd. Same element, same handler
    // pattern as playWord; a small timeout backstops the ended event.
    function playSilence(ms, onEnd) {
        detach();
        const audio = ensureAudio();
        const prevSrc = audio.src || '';
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearWatchdog();
            if (typeof onEnd === 'function') onEnd();
        };
        audio.onended = finish;
        audio.onerror = finish;
        audio.src = silenceUri(ms);
        if (prevSrc && prevSrc.startsWith('blob:')) {
            try { URL.revokeObjectURL(prevSrc); } catch (e) { /* ignore */ }
        }
        _watchdog = setTimeout(finish, ms + 1500);
        audio.play().catch(() => finish());
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
        const parts = meta.parts && typeof meta.parts === 'object'
                      ? Object.keys(meta.parts).length : 0;
        return {
            generation: meta.generation,
            clipCount : meta.clipCount,
            voices    : meta.voices || [],
            parts     : parts,
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
        pickClip       : pickClip,
        playTape       : playTape,
        playSilence    : playSilence,
        stop           : stop,
        deleteWord     : deleteWord,
        status         : status,
        clear          : clear,
    };
})();
