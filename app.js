// ============================================================
// app.js — English Master Pro main bootstrap
// ============================================================
// Responsibilities:
//   1. Expose window.App — the shared helper surface used by every
//      module: showToast, speak/stopSpeak, openSettings,
//      updateNotebookBadge, refreshStats.
//   2. On DOMContentLoaded, initialize every feature module
//      (MyWords, ExpressionCoach, SentenceDrill, WritingLab,
//      VocabDrill, Reader, SpeakingCoach).
//   3. Wire the top-level nav (tab switching) and the Settings +
//      Notebook modals and all their controls.
// ============================================================

(function() {
    'use strict';

    // ─── Toast ──────────────────────────────────────────────
    function showToast(msg, ms) {
        const dur       = Math.max(1500, Number(ms) || 2200);
        const host      = document.getElementById('toast-container');
        if (!host) { console.log('[toast]', msg); return; }

        const el         = document.createElement('div');
        el.className     = 'toast';
        el.textContent   = String(msg == null ? '' : msg);
        host.appendChild(el);

        // Trigger enter animation on next frame
        requestAnimationFrame(() => el.classList.add('toast-show'));

        setTimeout(() => {
            el.classList.remove('toast-show');
            setTimeout(() => el.remove(), 250);
        }, dur);
    }

    // ─── Speech synthesis ───────────────────────────────────
    // Android quirk: speechSynthesis.getVoices() often returns [] on
    // first call; voices arrive asynchronously via onvoiceschanged.
    // We keep a cached voice list and resolve a usable voice lazily.
    let cachedVoices = [];
    function refreshVoices() {
        try {
            cachedVoices = window.speechSynthesis?.getVoices?.() || [];
        } catch {
            cachedVoices = [];
        }
        return cachedVoices;
    }
    if ('speechSynthesis' in window) {
        refreshVoices();
        window.speechSynthesis.onvoiceschanged = () => {
            refreshVoices();
            // If Settings is open, repopulate the voice dropdown
            populateVoiceSelect();
        };
    }

    // Preferred voice substrings, in priority order. We check voice.name
    // for these (case-insensitive). Google and newer Microsoft voices
    // are dramatically less robotic than the old Microsoft David/Zira
    // bundled with Windows — those mechanical pauses at every comma are
    // a known problem with older SAPI5 voices.
    const PREFERRED_EN_VOICES = [
        'Google US English',
        'Google UK English Female',
        'Google UK English Male',
        'Microsoft Aria',       // Windows 11 online
        'Microsoft Jenny',      // Windows 11 online
        'Microsoft Guy',
        'Samantha',             // macOS / iOS
        'Karen',                // macOS en-AU
        'Daniel',               // macOS en-GB
        'Microsoft Mark',       // less robotic than David
        'Microsoft Zira'        // fallback — still better than David for some sentences
    ];

    function resolveVoice() {
        const wanted = window.DB?.getPref?.('tts_voice', '') || '';
        const voices = cachedVoices.length ? cachedVoices : refreshVoices();

        // User explicitly picked a voice — honor it.
        if (wanted && wanted !== '__default__') {
            return voices.find(v => v.voiceURI === wanted)
                || voices.find(v => v.name === wanted)
                || null;
        }

        // System Default: try to find a natural-sounding English voice
        // before falling back to whatever the OS chose (often robotic).
        for (const pref of PREFERRED_EN_VOICES) {
            const match = voices.find(v => (v.name || '').toLowerCase().includes(pref.toLowerCase()));
            if (match) return match;
        }
        return null;  // ultimate fallback — let the browser decide
    }

    // speakNative(text, rate?, onEnd?, opts?) — Web Speech API path.
    //   opts.lang — 'en-US' (default) | 'zh-CN' | BCP-47 tag.
    //   When lang is non-default English, we pick a matching voice from
    //   the available voices list; on Android where getVoices()==[], we
    //   still set utterance.lang so the system default TTS picks the
    //   right engine.
    function speakNative(text, rate, onEnd, opts) {
        if (!text || !('speechSynthesis' in window)) {
            if (typeof onEnd === 'function') onEnd();
            return;
        }
        const wantLang = (opts && opts.lang) || '';
        try {
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(String(text));

            // Voice / lang selection
            if (wantLang) {
                // Caller specified a language — find a voice matching it
                const voices = refreshVoices();
                const match  = voices.find(v => (v.lang || '').toLowerCase().startsWith(wantLang.toLowerCase().split('-')[0]));
                if (match) u.voice = match;
                u.lang = wantLang;
            } else {
                const v = resolveVoice();
                if (v) u.voice = v;
                u.lang = (v && v.lang) || 'en-US';
            }

            u.rate    = Number(rate) || parseFloat(window.DB?.getPref?.('speech_speed', '0.9')) || 0.9;
            u.pitch   = 1.05;   // slight lift helps voices like Google US English sound less flat
            u.volume  = 1;
            u.onend   = () => { if (typeof onEnd === 'function') onEnd(); };
            u.onerror = () => { if (typeof onEnd === 'function') onEnd(); };
            window.speechSynthesis.speak(u);
        } catch (e) {
            console.warn('[speak] failed:', e);
            if (typeof onEnd === 'function') onEnd();
        }
    }

    // ─── OpenAI neural TTS (optional, online) ────────────────
    // Device voices read full sentences with flat, robotic prosody.
    // When the user opts in (Settings → Voice engine → Neural), speech
    // is routed through OpenAI's gpt-4o-mini-tts, which sounds far more
    // natural. Synthesised clips are cached two ways:
    //   • in memory  — instant re-play within the session
    //   • IndexedDB  — survives reloads, so each unique text is fetched
    //                  from OpenAI at most once per device, ever; after
    //                  the first pass autoplay needs no network at all.
    // Transient failures (rate-limit 429, flaky network) are retried
    // with backoff before giving up; only then does it fall back to the
    // device voice. This prevents the "half OpenAI, half robotic" mix
    // that happens when one segment fails and silently downgrades.
    const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
    const NEURAL_VOICES  = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
    // Voices the pack generator accepts. The user picks a subset in
    // Settings; that subset drives both cloud generation and rotation.
    const PACK_VOICE_LIST    = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
    const PACK_VOICE_DEFAULT = ['ash', 'fable', 'nova', 'shimmer'];
    const _ttsCache      = new Map();   // `${voice}|${text}` → object URL (in-memory)
    let   _neuralAudio   = null;        // currently-playing HTMLAudioElement
    let   _neuralAbort   = null;        // AbortController for an in-flight fetch

    // --- Persistent on-device clip store (IndexedDB) ---
    const TTS_DB_NAME   = 'emp-tts';
    const TTS_STORE     = 'clips';
    const TTS_MAX_CLIPS = 1500;         // ~45 MB ceiling; oldest evicted past this
    let   _ttsDbPromise = null;

    function ttsDb() {
        if (_ttsDbPromise) return _ttsDbPromise;
        _ttsDbPromise = new Promise((resolve, reject) => {
            let req;
            try { req = indexedDB.open(TTS_DB_NAME, 1); }
            catch (e) { return reject(e); }
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(TTS_STORE)) {
                    const os = db.createObjectStore(TTS_STORE, { keyPath: 'k' });
                    os.createIndex('used', 'used');
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
        return _ttsDbPromise;
    }
    async function ttsCacheGet(key) {
        try {
            const db = await ttsDb();
            return await new Promise((resolve) => {
                const rq = db.transaction(TTS_STORE, 'readonly').objectStore(TTS_STORE).get(key);
                rq.onsuccess = () => resolve(rq.result ? rq.result.blob : null);
                rq.onerror   = () => resolve(null);
            });
        } catch { return null; }
    }
    async function ttsCachePut(key, blob) {
        try {
            const db = await ttsDb();
            await new Promise((resolve) => {
                const tx = db.transaction(TTS_STORE, 'readwrite');
                tx.objectStore(TTS_STORE).put({ k: key, blob: blob, used: Date.now() });
                tx.oncomplete = resolve;
                tx.onerror    = resolve;
            });
            ttsCacheEvict();   // fire-and-forget
        } catch {}
    }
    async function ttsCacheEvict() {
        try {
            const db = await ttsDb();
            const count = await new Promise((res) => {
                const rq = db.transaction(TTS_STORE, 'readonly').objectStore(TTS_STORE).count();
                rq.onsuccess = () => res(rq.result || 0);
                rq.onerror   = () => res(0);
            });
            if (count <= TTS_MAX_CLIPS) return;
            const toDelete = (count - TTS_MAX_CLIPS) + Math.floor(TTS_MAX_CLIPS * 0.2);
            const tx  = db.transaction(TTS_STORE, 'readwrite');
            const idx = tx.objectStore(TTS_STORE).index('used');   // oldest first
            let removed = 0;
            idx.openCursor().onsuccess = (e) => {
                const cur = e.target.result;
                if (cur && removed < toDelete) { cur.delete(); removed++; cur.continue(); }
            };
        } catch {}
    }

    function ttsEngine()   { return window.DB?.getPref?.('tts_engine', 'native') || 'native'; }
    function neuralVoice() {
        const v = window.DB?.getPref?.('tts_neural_voice', 'alloy') || 'alloy';
        return NEURAL_VOICES.includes(v) ? v : 'alloy';
    }
    function neuralKey() {
        // A dedicated TTS key wins; otherwise reuse the chat key when the
        // selected AI provider is OpenAI, so the key isn't entered twice.
        let raw = window.DB?.getPref?.('tts_openai_key', '') || '';
        if (!raw) {
            try {
                if (window.AIEngine?.getProvider?.() === 'openai') raw = window.DB?.getAPIKey?.() || '';
            } catch {}
        }
        // OpenAI keys are plain ASCII. A key pasted with an invisible
        // character (zero-width space, smart quote, full-width letter)
        // makes fetch() throw "non ISO-8859-1 code point" when the key is
        // placed in the Authorization header. Strip anything that is not
        // printable ASCII so the request can always be built.
        const clean = String(raw).replace(/[^\x21-\x7E]/g, '');
        if (clean.length !== String(raw).length && !_keyCleanWarned) {
            _keyCleanWarned = true;
            console.warn('[tts] OpenAI key contained ' +
                         (String(raw).length - clean.length) +
                         ' invalid character(s) \u2014 stripped (re-paste the key if neural still fails)');
        }
        return clean;
    }
    function neuralAvailable() {
        return ttsEngine() === 'neural' && !!neuralKey() && navigator.onLine !== false;
    }

    // OpenAI's API blocks direct browser calls (no CORS headers), so a
    // small pass-through proxy (a Cloudflare Worker) is required. The
    // user pastes its URL in Settings; requests go there instead of to
    // api.openai.com directly. Falls back to the direct URL only so the
    // error path can still report a clear "set the proxy URL" message.
    function ttsEndpoint() {
        const proxy = (window.DB?.getPref?.('tts_proxy_url', '') || '').trim();
        return proxy || OPENAI_TTS_URL;
    }

    // Translate a raw TTS error into a short, human explanation.
    function neuralErrorHint(err) {
        const m = (err && err.message) || String(err || '');
        if (/TTS_HTTP_401|TTS_HTTP_403/.test(m)) return 'API key was rejected — check the key in Settings.';
        if (/TTS_HTTP_429/.test(m))              return 'rate limited — wait a moment, or add API credit at platform.openai.com.';
        if (/TTS_HTTP_400/.test(m))              return 'request rejected (400) by OpenAI.';
        if (/TTS_HTTP_5\d\d/.test(m))            return 'OpenAI server error — try again shortly.';
        if (/Failed to fetch|NetworkError|load failed|ERR_/i.test(m)) {
            const hasProxy = !!(window.DB?.getPref?.('tts_proxy_url', '') || '').trim();
            return hasProxy
                ? 'could not reach the TTS proxy — check the proxy URL and your network.'
                : 'no TTS proxy set — OpenAI blocks direct browser calls. Add the proxy URL in Settings.';
        }
        return m || 'unknown error';
    }

    // Neural failures fall back to the device voice silently so playback
    // never dies — but a fully-silent fallback looks like "the engine
    // switch does nothing". Surface it once per session so the user knows
    // the device voice is a fallback, not the chosen engine.
    let _neuralFailureNotified = false;
    // Logged once if the stored OpenAI key had non-ASCII characters.
    let _keyCleanWarned = false;
    function notifyNeuralFailure(err) {
        if (_neuralFailureNotified) return;
        _neuralFailureNotified = true;
        showToast('Neural voice unavailable: ' + neuralErrorHint(err) + ' Using device voice.');
    }

    // Fetch one clip from OpenAI, retrying transient failures (429 rate
    // limit, 5xx) with backoff. Throws only after retries are exhausted
    // or on a non-retryable error (bad key / bad request).
    async function ttsFetch(text, voice, rate, key, signal) {
        const body = JSON.stringify({
            model           : 'gpt-4o-mini-tts',
            voice           : voice,
            input           : String(text),
            response_format : 'mp3',
            speed           : Math.max(0.5, Math.min(1.5, Number(rate) || 1))
        });
        const endpoint = ttsEndpoint();
        const viaProxy = endpoint !== OPENAI_TTS_URL;
        console.log('[tts] fetch \u2192 voice="' + voice + '" chars=' + String(text).length +
                    ' key=' + (key ? '\u2026' + String(key).slice(-4) : '(none)') +
                    ' via=' + (viaProxy ? 'proxy' : 'DIRECT (will be CORS-blocked)'));
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const resp = await fetch(endpoint, {
                    method : 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                    body   : body,
                    signal : signal
                });
                console.log('[tts] fetch \u2190 HTTP ' + resp.status + ' voice="' + voice +
                            '" attempt=' + (attempt + 1));
                if (resp.ok) {
                    const blob = await resp.blob();
                    console.log('[tts] ok \u2014 voice="' + voice + '" bytes=' + blob.size);
                    return blob;
                }

                // Non-retryable (bad key 401, bad request 400, …) — fail now.
                // The `noRetry` flag stops the catch below from retrying it.
                if (resp.status !== 429 && resp.status < 500) {
                    const fatal  = new Error('TTS_HTTP_' + resp.status);
                    fatal.noRetry = true;
                    throw fatal;
                }
                // Transient (429 rate limit / 5xx) — wait, then retry.
                lastErr = new Error('TTS_HTTP_' + resp.status);
                if (attempt < 2) {
                    const ra   = parseFloat(resp.headers.get('retry-after'));
                    const wait = ra > 0 ? ra * 1000 : 700 * (attempt + 1);
                    await new Promise(r => setTimeout(r, Math.min(wait, 4000)));
                }
            } catch (e) {
                if (e && e.name === 'AbortError') throw e;   // stopped on purpose
                if (e && e.noRetry)              throw e;   // bad key / bad request
                lastErr = e;                                 // network error — retry
                if (attempt < 2) await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
            }
        }
        throw lastErr || new Error('TTS_FAILED');
    }

    async function speakNeural(text, rate, onEnd) {
        // One-shot onEnd guard — fired by exactly one of: audio end, error.
        let done = false;
        const finish = () => { if (!done) { done = true; if (typeof onEnd === 'function') onEnd(); } };

        const voice  = neuralVoice();
        const key    = neuralKey();
        const cacheK = `${voice}|${text}`;
        try {
            stopSpeak();
            let url = _ttsCache.get(cacheK);
            if (!url) {
                // 1) on-device persistent cache — no network if present
                let blob = await ttsCacheGet(cacheK);
                if (!blob) {
                    // 2) fetch from OpenAI (with retry), then persist
                    _neuralAbort = new AbortController();
                    blob = await ttsFetch(text, voice, rate, key, _neuralAbort.signal);
                    _neuralAbort = null;
                    ttsCachePut(cacheK, blob);   // fire-and-forget
                }
                url = URL.createObjectURL(blob);
                // Bound the in-memory map so a long session doesn't leak.
                if (_ttsCache.size > 80) {
                    const oldest = _ttsCache.keys().next().value;
                    try { URL.revokeObjectURL(_ttsCache.get(oldest)); } catch {}
                    _ttsCache.delete(oldest);
                }
                _ttsCache.set(cacheK, url);
            }
            const audio = new Audio(url);
            _neuralAudio = audio;
            audio.onended = () => { if (_neuralAudio === audio) _neuralAudio = null; finish(); };
            audio.onerror = () => { if (_neuralAudio === audio) _neuralAudio = null; finish(); };
            await audio.play();
        } catch (err) {
            _neuralAbort = null;
            // Stopped on purpose (navigation, next segment) — do NOT advance
            // the autoplay chain.
            if (err && (err.name === 'AbortError')) return;
            console.warn('[tts] neural failed, using device voice:', err && err.message);
            notifyNeuralFailure(err);
            speakNative(text, rate, finish);
        }
    }

    // speak(text, rate?, onEnd?, opts?) — dispatches to the chosen engine.
    function speak(text, rate, onEnd, opts) {
        if (!text) { if (typeof onEnd === 'function') onEnd(); return; }
        const effRate = Number(rate) || parseFloat(window.DB?.getPref?.('speech_speed', '0.9')) || 0.9;
        // Neural (OpenAI) voices read English well but speak Chinese with a
        // strong foreign accent. Chinese text therefore always uses the
        // device's native Chinese voice; neural is reserved for English.
        const langOpt   = (opts && opts.lang) || '';
        const isChinese = /^(zh|cmn)/i.test(langOpt) || /[\u4e00-\u9fff]/.test(text);
        if (isChinese) {
            // Guarantee a Chinese tag so the device path selects a Chinese
            // voice even when the caller passed no lang.
            const zhOpts = Object.assign({}, opts, {
                lang: /^(zh|cmn)/i.test(langOpt) ? langOpt : 'zh-CN'
            });
            speakNative(text, effRate, onEnd, zhOpts);
        } else {
            // English: try the offline pack first so a covered word plays
            // with no key, proxy, or network. A miss (or no pack) falls
            // back to the neural voice, then the device voice.
            const fallback = () => {
                if (neuralAvailable()) speakNeural(text, effRate, onEnd);
                else speakNative(text, effRate, onEnd, opts);
            };
            if (window.TTSPack && window.TTSPack.playWord) {
                window.TTSPack.playWord(text, getPackVoices(), onEnd)
                    .then(played => { if (!played) fallback(); })
                    .catch(err => {
                        console.log('[pack] playWord error: ' + (err && err.message));
                        fallback();
                    });
            } else {
                console.log('[pack] TTSPack not loaded \u2014 using '
                            + (neuralAvailable() ? 'neural' : 'device') + ' voice');
                fallback();
            }
        }
    }

    // The "Test neural voice" button. Unlike normal playback, this does
    // NOT silently fall back to the device voice — it reports the real
    // outcome (success, or the specific failure) so the user can tell
    // whether the neural engine actually works and why if it doesn't.
    async function previewNeuralVoice() {
        const statusEl = document.getElementById('settings-tts-status');
        const setStatus = (txt) => { if (statusEl) statusEl.textContent = txt; };

        const key = neuralKey();
        if (!key) {
            showToast('Add an OpenAI key first (or set OpenAI as your AI provider).');
            setStatus('No OpenAI key set.');
            return;
        }
        const btn   = document.getElementById('settings-tts-test');
        const label = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Testing\u2026'; }
        const restore = () => { if (btn) { btn.disabled = false; btn.textContent = label || 'Test neural voice'; } };

        const voice  = neuralVoice();
        // A unique sentence each run. The proxy caches audio by request
        // body, so a fixed sample would be served straight from that
        // cache and the test would pass even with an invalid key. A
        // unique sentence forces a real call to OpenAI, so a passing
        // test genuinely means the key works.
        const sample = 'This is a neural voice test, sample number '
                     + Math.floor(Math.random() * 100000) + '.';
        console.log('[tts] TEST clicked \u2014 dropdown pref resolves to voice="' + voice + '"');
        setStatus('Testing voice "' + voice + '"\u2026');
        try {
            stopSpeak();
            const ctrl = new AbortController();
            const blob = await ttsFetch(sample, voice, 1, key, ctrl.signal);
            const url   = URL.createObjectURL(blob);
            const audio = new Audio(url);
            _neuralAudio = audio;
            // Release the object URL once playback finishes (or errors)
            // — the preview clip is one-shot and never replayed, so
            // keeping the URL alive just leaks memory per test click.
            const freeUrl = () => { try { URL.revokeObjectURL(url); } catch {} };
            audio.onended = () => { if (_neuralAudio === audio) _neuralAudio = null; freeUrl(); };
            audio.onerror = () => { if (_neuralAudio === audio) _neuralAudio = null; freeUrl(); };
            await audio.play();
            _neuralFailureNotified = false;            // confirmed working
            // The byte count differs per voice for the same text — if it
            // does NOT change when you switch voices, the request is not
            // varying and that pinpoints the bug.
            const kb = (blob.size / 1024).toFixed(1);
            setStatus('OK \u2014 voice "' + voice + '" \u00b7 ' + kb + ' KB');
            showToast(`Neural voice works \u2014 playing voice "${voice}".`);
        } catch (err) {
            console.warn('[tts] TEST failed:', err && err.message);
            setStatus('Failed (voice "' + voice + '"): ' + neuralErrorHint(err));
            showToast('Neural test failed: ' + neuralErrorHint(err));
        } finally {
            restore();
        }
    }

    // ─── Pre-generated pronunciation pack ───────────────────
    // The pack downloads bundled word audio to this device so covered
    // words play with no key, proxy, or live network. The engine lives
    // in tts-pack.js (window.TTSPack); these helpers wire it to the
    // Settings UI.
    async function downloadAudioPack() {
        const btn     = document.getElementById('settings-pack-download');
        const statEl  = document.getElementById('settings-pack-status');
        const setStat = (m) => { if (statEl) statEl.textContent = m; };
        if (!window.TTSPack) { setStat('Audio pack module not loaded.'); return; }
        const label = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Working\u2026'; }
        try {
            await window.TTSPack.download(setStat);
        } catch (err) {
            console.warn('[pack] download failed:', err && err.message);
            setStat('Failed: ' + ((err && err.message) || err));
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = label || 'Download audio pack'; }
            hydratePackStatus();
            hydratePackCoverage();
        }
    }

    function hydratePackStatus() {
        const statEl = document.getElementById('settings-pack-status');
        if (!statEl || !window.TTSPack) return;
        window.TTSPack.status().then(s => {
            statEl.textContent = s
                ? 'Installed \u2014 generation ' + s.generation + ', '
                  + s.clipCount + ' clip(s), ' + s.voices.length + ' voice(s).'
                : 'No pack installed yet.';
        }).catch(() => {});
    }

    // The voices the user picks for the pack. The set is saved as a
    // pref and written into the exported word list, so the cloud
    // generator synthesises exactly these and playback rotates them.
    function getPackVoices() {
        let saved = [];
        try { saved = JSON.parse(window.DB?.getPref?.('pack_voices', '') || '[]'); }
        catch (e) { saved = []; }
        if (!Array.isArray(saved)) saved = [];
        const set    = new Set(saved.map(v => String(v).toLowerCase()));
        const chosen = PACK_VOICE_LIST.filter(v => set.has(v));
        return chosen.length ? chosen : PACK_VOICE_DEFAULT.slice();
    }

    function setPackVoices(voices) {
        const set    = new Set((voices || []).map(v => String(v).toLowerCase()));
        const chosen = PACK_VOICE_LIST.filter(v => set.has(v));
        window.DB?.setPref?.('pack_voices', JSON.stringify(chosen));
        return chosen;
    }

    // Word-index range to synthesise per cloud build, e.g. \"1-50\". Blank
    // means all words. The value is written into the exported word list
    // as a \"# range:\" header; the generator builds only the word blocks
    // whose index falls in the range. Each build is incremental, so the
    // range is just a way to pace a large pack across several runs.
    // Returns a normalised \"LO-HI\" string, or '' for no range.
    function getPackRange() {
        const raw = (window.DB?.getPref?.('pack_range', '') || '').trim();
        return normalizeRange(raw);
    }

    // Accepts \"1-50\", \"1 - 50\", \"1..50\", \"1 50\"; returns \"1-50\" or ''.
    function normalizeRange(raw) {
        const m = String(raw || '')
            .replace(/\u2013|\.\./g, '-')
            .match(/(\d+)\s*[-\s]\s*(\d+)/);
        if (!m) return '';
        let lo = parseInt(m[1], 10);
        let hi = parseInt(m[2], 10);
        if (!(lo > 0) || !(hi > 0)) return '';
        if (lo > hi) { const t = lo; lo = hi; hi = t; }
        return lo + '-' + hi;
    }

    function setPackRange(value) {
        window.DB?.setPref?.('pack_range', normalizeRange(value));
    }

    function hydratePackRange() {
        const el = document.getElementById('settings-pack-range');
        if (!el) return;
        el.value = getPackRange();
    }

    function renderPackVoiceChecks() {
        const box = document.getElementById('settings-pack-voices');
        if (!box) return;
        const chosen = new Set(getPackVoices());
        box.innerHTML = PACK_VOICE_LIST.map(v => {
            const cap = v.charAt(0).toUpperCase() + v.slice(1);
            return '<label style="display:flex;align-items:center;gap:4px;'
                 + 'cursor:pointer;font-size:11px;color:var(--text-secondary)">'
                 + '<input type="checkbox" data-voice="' + v + '"'
                 + (chosen.has(v) ? ' checked' : '') + '> ' + cap + '</label>';
        }).join('');
        box.querySelectorAll('input[data-voice]').forEach(cb => {
            cb.addEventListener('change', onPackVoiceToggle);
        });
    }

    function onPackVoiceToggle() {
        const box = document.getElementById('settings-pack-voices');
        if (!box) return;
        const picked = [];
        box.querySelectorAll('input[data-voice]').forEach(cb => {
            if (cb.checked) picked.push(cb.dataset.voice);
        });
        if (!picked.length) {
            // An empty set would leave nothing to generate; keep one.
            showToast('Keep at least one voice selected.');
            renderPackVoiceChecks();
            return;
        }
        setPackVoices(picked);
    }

    // Normalise a speakable string the same way the pack generator and
    // the pack key builder do: trim, lowercase, collapse whitespace. This
    // guarantees the key the app looks up matches the key the generator
    // stored, even for multi-word phrases and sentences.
    function _normSpeak(s) {
        return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
    }

    // Assign a stable packIndex to every notebook word that lacks one,
    // and persist it. The index is permanent: a word keeps its number
    // across future exports, shuffles, edits, and even after other words
    // are deleted, so an audio-pack range like \"51-100\" always refers to
    // the same 50 words. New words are numbered after the current highest
    // index, in the order they were added.
    function ensurePackIndices() {
        const nb = window.DB?.loadNotebook?.() || [];
        let maxIdx = 0;
        nb.forEach(w => {
            const n = Number(w && w.packIndex) || 0;
            if (n > maxIdx) maxIdx = n;
        });
        const unindexed = nb.filter(w => w && !(Number(w.packIndex) > 0));
        if (!unindexed.length) return nb;
        unindexed.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
        unindexed.forEach(w => { w.packIndex = ++maxIdx; });
        window.DB.saveNotebook(nb);
        return nb;
    }

    // Build one indexed block per notebook word, ordered by packIndex.
    // Each block is { index, word, entries[] }; entries are every English
    // string spoken for that word (the word, its definition, its example
    // sentence, its collocations), normalised and de-duplicated globally
    // so a string is synthesised once. Chinese fields are excluded — they
    // always use the device voice and never the offline pack.
    function notebookSpeechBlocks() {
        const nb     = ensurePackIndices();
        const seen   = new Set();
        const blocks = [];
        nb.slice()
          .sort((a, b) => (Number(a.packIndex) || 0) - (Number(b.packIndex) || 0))
          .forEach(w => {
            if (!w) return;
            const entries = [];
            const add = (s) => {
                const n = _normSpeak(s);
                if (!n || /[\u4e00-\u9fff]/.test(n) || seen.has(n)) return;
                seen.add(n);
                entries.push(n);
            };
            add(w.word);
            add(w.enDef);
            add(w.context);
            (w.collo || '').split(/\s*·\s*/).forEach(add);
            if (entries.length) {
                blocks.push({
                    index   : Number(w.packIndex) || 0,
                    word    : _normSpeak(w.word) || '(word)',
                    entries : entries
                });
            }
          });
        return blocks;
    }

    // The flat list of every speakable string, for the coverage readout.
    // Side-effect free (does not assign or persist indices).
    function notebookSpeechList() {
        const seen = new Set();
        const out  = [];
        const add  = (s) => {
            const n = _normSpeak(s);
            if (!n || /[\u4e00-\u9fff]/.test(n) || seen.has(n)) return;
            seen.add(n);
            out.push(n);
        };
        (window.DB?.loadNotebook?.() || []).forEach(it => {
            if (!it) return;
            add(it.word);
            add(it.enDef);
            add(it.context);
            (it.collo || '').split(/\s*·\s*/).forEach(add);
        });
        return out;
    }

    function hydratePackCoverage() {
        const el = document.getElementById('settings-pack-coverage');
        if (!el || !window.TTSPack) return;
        window.TTSPack.coverage(notebookSpeechList()).then(c => {
            el.textContent = c.total
                ? c.total + ' item(s) \u00b7 ' + c.covered + ' with audio \u00b7 '
                  + c.missing + ' missing'
                : 'No words in your bank yet.';
        }).catch(() => {});
    }

    // Write the word bank to a wordlist.txt download. Each word becomes a
    // block tagged  #@<index> <word>  with a stable index, followed by
    // every English string spoken for it (word, definition, example
    // sentence, collocations). The user replaces tools/wordlist.txt with
    // this file and commits it; the cloud build fills in missing audio.
    // A \"# range:\" header (set in Settings) tells the build to do only
    // one batch of word indices, e.g. 1-50, so a large pack can be built
    // across several runs.
    function exportWordList() {
        const blocks = notebookSpeechBlocks();
        if (!blocks.length) { showToast('No words to export.'); return; }

        const itemCount = blocks.reduce((n, b) => n + b.entries.length, 0);
        const idxMax    = blocks.reduce((m, b) => Math.max(m, b.index), 0);
        const range     = getPackRange();

        const header = [
            '# EMPro audio pack - word list',
            '# Exported ' + new Date().toISOString().slice(0, 10) + ' from the app.',
            '# Replace tools/wordlist.txt with this file, then commit it.',
            '# Each block is tagged  #@<index> <word>  with a stable index.',
            '# voices: ' + getPackVoices().join(', ')
        ];
        if (range) {
            header.push('# range: ' + range
                        + '   (build only word indices in this range)');
        } else {
            header.push('# (no range set - building all ' + idxMax + ' words; '
                        + 'add e.g.  "# range: 1-50"  to build one batch)');
        }
        header.push('# ' + blocks.length + ' word(s), ' + itemCount + ' item(s)');
        header.push('');

        const lines = [];
        blocks.forEach(b => {
            lines.push('#@' + b.index + ' ' + b.word);
            b.entries.forEach(e => lines.push(e));
        });

        const blob = new Blob([header.concat(lines).join('\n') + '\n'],
                              { type: 'text/plain' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = 'wordlist.txt';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000);
        showToast('Exported ' + blocks.length + ' word(s) / '
                  + itemCount + ' item(s)' + (range ? ' \u00b7 range ' + range : '')
                  + '.');
    }

    function stopSpeak() {
        try { window.speechSynthesis?.cancel?.(); } catch {}
        try { if (_neuralAbort) { _neuralAbort.abort(); _neuralAbort = null; } } catch {}
        try {
            if (_neuralAudio) {
                _neuralAudio.pause();
                _neuralAudio.onended = null;
                _neuralAudio.onerror = null;
                _neuralAudio = null;
            }
        } catch {}
        try { window.TTSPack?.stop?.(); } catch {}
    }

    // ─── Header stats ───────────────────────────────────────
    function updateNotebookBadge() {
        const nb        = window.DB?.loadNotebook?.() || [];
        const count     = nb.length;

        const headerEl  = document.getElementById('stat-notebook');
        if (headerEl) headerEl.textContent = String(count);

        const btnBadge  = document.getElementById('notebook-badge');
        if (btnBadge) {
            btnBadge.textContent   = String(count);
            btnBadge.style.display = count > 0 ? '' : 'none';
        }
    }

    function refreshStats() {
        const stats     = window.DB?.loadStats?.() || {};
        const streakEl  = document.getElementById('stat-streak');
        if (streakEl) streakEl.textContent = String(stats.streakDays || 0);
        updateNotebookBadge();
    }

    // ─── Settings modal ─────────────────────────────────────
    function openSettings() {
        const modal = document.getElementById('settings-modal');
        if (!modal) return;
        hydrateSettingsUI();
        activateSettingsTab('set-general');   // always open on the first tab
        modal.classList.add('open');
    }
    function closeSettings() {
        document.getElementById('settings-modal')?.classList.remove('open');
    }

    // Settings is split into tabbed panels (General / Voice / AI / Sync /
    // Data) so it no longer scrolls as one long page.
    function activateSettingsTab(panelId) {
        document.querySelectorAll('.set-tab').forEach(t =>
            t.classList.toggle('active', t.dataset.setpanel === panelId));
        document.querySelectorAll('.set-panel').forEach(p =>
            p.classList.toggle('active', p.id === panelId));
    }
    function bindSettingsTabs() {
        document.querySelectorAll('.set-tab').forEach(tab => {
            tab.addEventListener('click', () => activateSettingsTab(tab.dataset.setpanel));
        });
    }

    function hydrateSettingsUI() {
        // Profile
        const nameEl = document.getElementById('settings-profile-name');
        if (nameEl) nameEl.value = getProfileName();

        // Voice
        populateVoiceSelect();
        hydrateNeuralTtsUI();
        hydratePackStatus();
        renderPackVoiceChecks();
        hydratePackRange();
        hydratePackCoverage();

        // Speed
        const speedEl   = document.getElementById('settings-speed');
        const speedVal  = document.getElementById('settings-speed-val');
        const savedSpd  = parseFloat(window.DB.getPref('speech_speed', '0.9')) || 0.9;
        if (speedEl)    speedEl.value        = String(savedSpd);
        if (speedVal)   speedVal.textContent = savedSpd.toFixed(2);

        // Auto-pronounce components (word is always on; these 4 are user-configurable)
        const apEndef = document.getElementById('settings-autoplay-endef');
        const apCn    = document.getElementById('settings-autoplay-cn');
        const apColo  = document.getElementById('settings-autoplay-collo');
        const apSent  = document.getElementById('settings-autoplay-sent');
        if (apEndef) apEndef.checked = window.DB.getPref('autoplay_endef', 'true') === 'true';
        if (apCn)    apCn.checked    = window.DB.getPref('autoplay_cn',    'true') === 'true';
        if (apColo)  apColo.checked  = window.DB.getPref('autoplay_collo', 'true') === 'true';
        if (apSent)  apSent.checked  = window.DB.getPref('autoplay_sent',  'true') === 'true';

        // Group size
        const gsEl      = document.getElementById('settings-group-size');
        if (gsEl) gsEl.value = window.DB.getPref('group_size', '20');

        // Show CN by default
        const cnEl      = document.getElementById('settings-show-cn');
        if (cnEl) cnEl.checked = window.DB.getPref('show_cn_default', 'false') === 'true';

        // AI provider / model
        populateProviderSelect();
        populateModelSelect();

        // API key (masked echo — only show if already saved)
        const keyEl     = document.getElementById('api-key-input');
        const keyLbl    = document.getElementById('api-key-label');
        if (keyEl) {
            const k = window.DB.getAPIKey();
            keyEl.value       = k ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + k.slice(-4) : '';
            keyEl.placeholder = window.AIEngine.getProviderDef().keyHint || 'API key';
        }
        if (keyLbl) keyLbl.textContent = `${window.AIEngine.getProviderDef().label} key`;

        // Sync token
        const tokEl     = document.getElementById('sync-github-token');
        if (tokEl) {
            const t = window.SyncManager?.getToken?.() || '';
            tokEl.value = t ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + t.slice(-4) : '';
        }

        // Debug panel toggle
        const dbgEl     = document.getElementById('pref-debug-panel');
        if (dbgEl) dbgEl.checked = window.DB.getPref('debug_panel_enabled', 'false') === 'true';
    }

    function populateVoiceSelect() {
        const sel = document.getElementById('settings-voice');
        if (!sel) return;
        const voices    = refreshVoices();
        const saved     = window.DB?.getPref?.('tts_voice', '__default__') || '__default__';

        // Filter: only English and Chinese voices — those are the two languages
        // the app actually uses (EN for learning content, ZH for translations).
        // Covers en-*, zh-*, and cmn-* (Mandarin BCP-47 tag).
        const isRelevant = (v) => {
            const lang = (v.lang || '').toLowerCase();
            return lang.startsWith('en') || lang.startsWith('zh') || lang.startsWith('cmn');
        };

        // Android fallback: always include a "System Default" option because
        // getVoices() may return [] permanently on some devices.
        let html = `<option value="__default__">System Default${voices.length ? '' : ' (voice list unavailable)'}</option>`;

        // Build filtered list: English voices first, then Chinese
        const filtered = voices.filter(isRelevant);
        const en       = filtered.filter(v => (v.lang || '').toLowerCase().startsWith('en'));
        const zh       = filtered.filter(v => !((v.lang || '').toLowerCase().startsWith('en')));

        // Escape hatch: if the user has previously saved a voice that's now
        // being filtered out (e.g. a French voice from before this filter),
        // still include it so they don't silently lose their setting.
        const savedVoice = voices.find(v => (v.voiceURI === saved) || (v.name === saved));
        const savedOutsideFilter = savedVoice && !isRelevant(savedVoice);

        [...en, ...zh].forEach(v => {
            const val = v.voiceURI || v.name;
            html += `<option value="${escapeAttr(val)}">${escapeHtml(v.name)} \u2014 ${escapeHtml(v.lang || '')}</option>`;
        });

        if (savedOutsideFilter) {
            const val = savedVoice.voiceURI || savedVoice.name;
            html += `<option value="${escapeAttr(val)}">${escapeHtml(savedVoice.name)} \u2014 ${escapeHtml(savedVoice.lang || '')} (saved)</option>`;
        }

        sel.innerHTML = html;
        sel.value     = saved;
    }

    // Fill the neural-TTS controls from saved prefs and show/hide the
    // detail box depending on the chosen engine.
    function hydrateNeuralTtsUI() {
        const engEl   = document.getElementById('settings-tts-engine');
        const voiceEl = document.getElementById('settings-neural-voice');
        const keyEl   = document.getElementById('settings-tts-key');
        const boxEl   = document.getElementById('settings-neural-box');

        const engine  = window.DB?.getPref?.('tts_engine', 'native') || 'native';
        if (engEl) engEl.value = engine;
        if (boxEl) boxEl.style.display = (engine === 'neural') ? '' : 'none';

        if (voiceEl) {
            const saved = window.DB?.getPref?.('tts_neural_voice', 'alloy') || 'alloy';
            voiceEl.innerHTML = NEURAL_VOICES.map(
                v => `<option value="${v}">${v.charAt(0).toUpperCase() + v.slice(1)}</option>`
            ).join('');
            voiceEl.value = NEURAL_VOICES.includes(saved) ? saved : 'alloy';
        }
        if (keyEl) keyEl.value = window.DB?.getPref?.('tts_openai_key', '') || '';
        const proxyEl = document.getElementById('settings-tts-proxy');
        if (proxyEl) proxyEl.value = window.DB?.getPref?.('tts_proxy_url', '') || '';
    }

    function populateProviderSelect() {
        const sel = document.getElementById('settings-ai-provider');
        if (!sel) return;
        const current = window.AIEngine.getProvider();
        const opts = Object.entries(window.AIEngine.PROVIDERS).map(
            ([key, def]) => `<option value="${key}">${escapeHtml(def.label)}</option>`
        ).join('');
        sel.innerHTML = opts;
        sel.value     = current;
    }

    function populateModelSelect() {
        const sel = document.getElementById('settings-ai-model');
        if (!sel) return;
        const prov    = window.AIEngine.getProviderDef();
        const current = window.AIEngine.getModel();
        sel.innerHTML = (prov.models || []).map(
            m => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`
        ).join('');
        sel.value = current;
    }

    function bindSettingsHandlers() {
        // Close
        document.getElementById('settings-close')?.addEventListener('click', closeSettings);
        document.getElementById('settings-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'settings-modal') closeSettings();
        });

        // Voice / speed / auto-speak
        document.getElementById('settings-voice')?.addEventListener('change', (e) => {
            window.DB.setPref('tts_voice', e.target.value);
        });

        // Profile name — cosmetic; PROFILE_ID is untouched so data is safe.
        document.getElementById('settings-profile-name')?.addEventListener('change', (e) => {
            const saved = setProfileName(e.target.value);
            e.target.value = saved;
            showToast('Name updated.');
        });

        // Voice engine (device vs OpenAI neural)
        document.getElementById('settings-tts-engine')?.addEventListener('change', (e) => {
            window.DB.setPref('tts_engine', e.target.value);
            _neuralFailureNotified = false;
            const box = document.getElementById('settings-neural-box');
            if (box) box.style.display = (e.target.value === 'neural') ? '' : 'none';
        });
        document.getElementById('settings-neural-voice')?.addEventListener('change', (e) => {
            window.DB.setPref('tts_neural_voice', e.target.value);
            _neuralFailureNotified = false;
            // Logs the dropdown value AND what neuralVoice() reads back —
            // if these ever disagree, the pref save/read is the bug.
            console.log('[tts] voice dropdown changed \u2192 "' + e.target.value +
                        '" | neuralVoice() reads back "' + neuralVoice() + '"');
        });
        document.getElementById('settings-tts-key')?.addEventListener('input', (e) => {
            window.DB.setPref('tts_openai_key', (e.target.value || '').replace(/[^\x21-\x7E]/g, ''));
            _neuralFailureNotified = false;
            _keyCleanWarned = false;
        });
        document.getElementById('settings-tts-proxy')?.addEventListener('input', (e) => {
            window.DB.setPref('tts_proxy_url', (e.target.value || '').trim());
            _neuralFailureNotified = false;
        });
        document.getElementById('settings-tts-test')?.addEventListener('click', () => {
            previewNeuralVoice();
        });
        document.getElementById('settings-pack-download')?.addEventListener('click', () => {
            downloadAudioPack();
        });
        document.getElementById('settings-pack-export')?.addEventListener('click', () => {
            exportWordList();
        });
        document.getElementById('settings-pack-range')?.addEventListener('change', (e) => {
            setPackRange(e.target.value);
            hydratePackRange();   // echo the normalised value back
        });
        const speedEl = document.getElementById('settings-speed');
        speedEl?.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value) || 0.9;
            document.getElementById('settings-speed-val').textContent = v.toFixed(2);
            window.DB.setPref('speech_speed', String(v));
        });
        document.getElementById('settings-autoplay-endef')?.addEventListener('change', (e) => {
            window.DB.setPref('autoplay_endef', e.target.checked ? 'true' : 'false');
        });
        document.getElementById('settings-autoplay-cn')?.addEventListener('change', (e) => {
            window.DB.setPref('autoplay_cn', e.target.checked ? 'true' : 'false');
        });
        document.getElementById('settings-autoplay-collo')?.addEventListener('change', (e) => {
            window.DB.setPref('autoplay_collo', e.target.checked ? 'true' : 'false');
        });
        document.getElementById('settings-autoplay-sent')?.addEventListener('change', (e) => {
            window.DB.setPref('autoplay_sent', e.target.checked ? 'true' : 'false');
        });

        // Study
        document.getElementById('settings-group-size')?.addEventListener('change', (e) => {
            const n = Math.max(5, Math.min(100, parseInt(e.target.value, 10) || 20));
            e.target.value = String(n);
            window.DB.setPref('group_size', String(n));
            window.MyWords?.render?.();
        });
        document.getElementById('settings-show-cn')?.addEventListener('change', (e) => {
            window.DB.setPref('show_cn_default', e.target.checked ? 'true' : 'false');
            window.MyWords?.render?.();
        });

        // AI provider / model
        document.getElementById('settings-ai-provider')?.addEventListener('change', (e) => {
            window.DB.setPref('ai_provider', e.target.value);
            // Reset model pref so AIEngine.getModel() falls back to the new provider's default
            window.DB.setPref('ai_model', '');
            populateModelSelect();
            // Update API key label + hint for the new provider
            const keyEl  = document.getElementById('api-key-input');
            const keyLbl = document.getElementById('api-key-label');
            if (keyEl)  keyEl.placeholder  = window.AIEngine.getProviderDef().keyHint || 'API key';
            if (keyLbl) keyLbl.textContent = `${window.AIEngine.getProviderDef().label} key`;
        });
        document.getElementById('settings-ai-model')?.addEventListener('change', (e) => {
            window.DB.setPref('ai_model', e.target.value);
        });

        // Save API key
        document.getElementById('btn-save-api-key')?.addEventListener('click', () => {
            const el = document.getElementById('api-key-input');
            const v  = (el?.value || '').trim();
            if (!v || v.startsWith('\u2022')) { showToast('Enter a new API key first.'); return; }
            window.DB.setAPIKey(v);
            el.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + v.slice(-4);
            showToast('API key saved.');
        });

        // Test API
        document.getElementById('btn-test-api')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            if (!window.AIEngine.hasAPIKey()) { showToast('Save an API key first.'); return; }
            const originalText = btn.textContent;
            btn.disabled    = true;
            btn.textContent = 'Testing\u2026';
            try {
                const out = await window.AIEngine.callClaude(
                    'You are a terse assistant. Reply with exactly: OK',
                    'ping',
                    { maxTokens: 20 }
                );
                showToast(out.trim().toLowerCase().includes('ok') ? 'API key works!' : `Got: ${out.slice(0, 60)}`);
            } catch (err) {
                showToast(window.AIEngine.friendlyError(err));
            } finally {
                btn.disabled    = false;
                btn.textContent = originalText;
            }
        });

        // Sync token
        document.getElementById('btn-save-sync-token')?.addEventListener('click', () => {
            const el = document.getElementById('sync-github-token');
            const v  = (el?.value || '').trim();
            if (!v || v.startsWith('\u2022')) { showToast('Enter a new GitHub token first.'); return; }
            window.SyncManager?.setToken?.(v);
            el.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + v.slice(-4);
            showToast('Sync token saved.');
            window.SyncManager?.setupSync?.();
        });
        document.getElementById('btn-sync-push')?.addEventListener('click', () => window.SyncManager?.push?.(true));
        document.getElementById('btn-sync-pull')?.addEventListener('click', () => window.SyncManager?.pull?.(true));

        // Debug panel toggle
        document.getElementById('pref-debug-panel')?.addEventListener('change', (e) => {
            window.DB.setPref('debug_panel_enabled', e.target.checked ? 'true' : 'false');
            // The module exposes itself as window.Debug; older builds used
            // window.DebugPanel. Accept either so settings toggle never
            // forces a reload when the live API is available.
            const debugApi = window.Debug || window.DebugPanel;
            if (debugApi?.setEnabled) {
                debugApi.setEnabled(e.target.checked);
            } else {
                // Fall back to reload so debug-panel.js picks up the new pref on next boot
                showToast('Reloading to apply\u2026');
                setTimeout(() => location.reload(), 600);
            }
        });

        // Export
        document.getElementById('btn-export')?.addEventListener('click', () => {
            try {
                // Privacy: ask before bundling the API key into the backup file.
                // Default no — most users export to move learning data, not keys.
                const includeKey = confirm(
                    'Include your API key in the backup file?\n\n' +
                    'OK = include (convenient, but the key is plaintext in the file).\n' +
                    'Cancel = exclude (safer; you\'ll re-enter the key after import).'
                );
                const json = window.DB.exportAll({ includeApiKey: includeKey });
                const blob = new Blob([json], { type: 'application/json' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href     = url;
                a.download = `english-master-pro-backup-${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
                showToast(includeKey ? 'Backup downloaded (with API key).' : 'Backup downloaded (no API key).');
            } catch (err) {
                showToast('Export failed: ' + (err.message || err));
            }
        });

        // Import — true overwrite: clears profile keys before applying the backup
        // so stale entries don't survive. The confirm prompt promises this; now
        // it actually does it.
        document.getElementById('btn-import')?.addEventListener('click', () => {
            const inp      = document.createElement('input');
            inp.type       = 'file';
            inp.accept     = 'application/json,.json';
            inp.onchange   = (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const rd = new FileReader();
                rd.onload = () => {
                    if (!confirm('Import will overwrite current data. Continue?')) return;
                    const ok = window.DB.importAll(rd.result, { replace: true });
                    if (ok) {
                        showToast('Imported. Reloading\u2026');
                        setTimeout(() => location.reload(), 800);
                    } else {
                        showToast('Import failed \u2014 invalid file.');
                    }
                };
                rd.readAsText(file);
            };
            inp.click();
        });

        // Clear words only
        document.getElementById('btn-clear-words')?.addEventListener('click', () => {
            if (!confirm('Remove ALL vocabulary? This cannot be undone.')) return;
            window.DB.saveNotebook([]);
            updateNotebookBadge();
            window.MyWords?.refreshStudyList?.();
            window.MyWords?.render?.();
            showToast('All words cleared.');
        });

        // Factory reset — two-stage so the user can choose whether to also
        // wipe API key and sync credentials. The previous version silently
        // left those behind, which was a privacy footgun on shared devices.
        document.getElementById('btn-factory-reset')?.addEventListener('click', () => {
            if (!confirm('FACTORY RESET: wipe all app data for this profile? This cannot be undone.')) return;
            if (!confirm('Are you absolutely sure? All words, history, and settings will be lost.')) return;
            const wipeCreds = confirm(
                'Also clear API key and cloud-sync credentials?\n\n' +
                'OK = clear everything (full reset, including keys/tokens).\n' +
                'Cancel = keep API key and sync token (only learning data is wiped).'
            );
            window.DB.factoryReset({ clearCredentials: wipeCreds });
            showToast(wipeCreds ? 'Full reset complete. Reloading\u2026' : 'Learning data wiped. Reloading\u2026');
            setTimeout(() => location.reload(), 800);
        });

        document.getElementById('btn-merge-forms')?.addEventListener('click', openMergeForms);
    }

    // ─── Notebook modal ─────────────────────────────────────
    function openNotebook() {
        const modal = document.getElementById('notebook-modal');
        if (!modal) return;
        renderNotebookList('');
        const searchEl = document.getElementById('notebook-search');
        if (searchEl) searchEl.value = '';
        modal.classList.add('open');
    }
    function closeNotebook() {
        document.getElementById('notebook-modal')?.classList.remove('open');
    }

    // ─── Merge word forms (inflected-duplicate cleanup) ─────
    // Builds a review modal listing groups of entries that are the same word
    // in different forms (cap / capping / caps). The user picks the form to
    // keep per group and confirms; nothing changes until they tap Merge.
    function openMergeForms() {
        const groups = window.DB?.findInflectionGroups?.() || [];
        document.getElementById('merge-forms-modal')?.remove();

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay open';
        overlay.id        = 'merge-forms-modal';

        if (groups.length === 0) {
            overlay.innerHTML = `
                <div class="modal-card" style="max-width:460px">
                    <div class="modal-header"><h2>Merge word forms</h2><button class="modal-close" data-mgf-close>&times;</button></div>
                    <div class="modal-body">
                        <p style="font-size:13px;color:var(--text-secondary)">No duplicate word forms found &mdash; every entry in your notebook is already a distinct word.</p>
                    </div>
                </div>`;
        } else {
            const groupHtml = groups.map((g, gi) => {
                const opts = g.members.map((m, mi) => {
                    const id        = `mgf-${gi}-${mi}`;
                    const tag       = m.complete ? '' : '<span style="font-size:10px;color:var(--danger);margin-left:6px">needs enrich</span>';
                    const baseHint  = m.isBase  ? '<span style="font-size:10px;color:var(--text-tertiary);margin-left:6px">suggested base</span>' : '';
                    return `
                        <label for="${id}" style="display:flex;align-items:center;gap:8px;padding:5px 2px;cursor:pointer;font-size:14px">
                            <input type="radio" id="${id}" name="mgf-keep-${gi}" value="${escapeAttr(m.word)}" ${m.isBase ? 'checked' : ''} style="cursor:pointer">
                            <span style="font-weight:500">${escapeHtml(m.word)}</span>${baseHint}${tag}
                        </label>`;
                }).join('');
                return `
                    <div class="mgf-group" data-mgf-group="${gi}" style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:10px">
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:4px;font-size:12px;color:var(--text-tertiary)">
                            <input type="checkbox" class="mgf-include" data-mgf-include="${gi}" checked style="cursor:pointer">
                            Merge these ${g.members.length} forms &mdash; keep:
                        </label>
                        ${opts}
                    </div>`;
            }).join('');

            overlay.innerHTML = `
                <div class="modal-card" style="max-width:520px;max-height:82vh;display:flex;flex-direction:column">
                    <div class="modal-header"><h2>Merge word forms</h2><button class="modal-close" data-mgf-close>&times;</button></div>
                    <div class="modal-body" style="overflow-y:auto">
                        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">
                            Found ${groups.length} group${groups.length === 1 ? '' : 's'} of the same word in different forms.
                            Pick the form to keep in each group &mdash; the others merge into it (blank fields are filled in and focus tags combined). Uncheck a group to leave it untouched.
                        </p>
                        ${groupHtml}
                    </div>
                    <div style="display:flex;gap:8px;justify-content:flex-end;padding:12px 20px;border-top:1px solid var(--border)">
                        <button class="wl-btn-secondary" data-mgf-close style="padding:7px 12px">Cancel</button>
                        <button class="wl-btn-primary" id="mgf-apply" style="padding:7px 12px">Merge selected (${groups.length})</button>
                    </div>
                </div>`;
        }

        document.body.appendChild(overlay);

        const onKey = (e) => { if (e.key === 'Escape') close(); };
        const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
        document.addEventListener('keydown', onKey);
        overlay.querySelectorAll('[data-mgf-close]').forEach(b => b.addEventListener('click', close));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        const applyBtn = overlay.querySelector('#mgf-apply');
        const recount  = () => {
            if (!applyBtn) return;
            const n = overlay.querySelectorAll('.mgf-include:checked').length;
            applyBtn.textContent   = `Merge selected (${n})`;
            applyBtn.disabled      = n === 0;
            applyBtn.style.opacity = n === 0 ? '0.5' : '';
        };
        overlay.querySelectorAll('.mgf-include').forEach(cb => cb.addEventListener('change', recount));

        if (applyBtn) {
            applyBtn.addEventListener('click', () => {
                let totalMerged = 0, groupsMerged = 0;
                overlay.querySelectorAll('.mgf-group').forEach(groupEl => {
                    const include = groupEl.querySelector('.mgf-include');
                    if (!include || !include.checked) return;
                    const gi     = groupEl.getAttribute('data-mgf-group');
                    const keepEl = overlay.querySelector(`input[name="mgf-keep-${gi}"]:checked`);
                    if (!keepEl) return;
                    const keep   = keepEl.value;
                    const drops  = Array.from(groupEl.querySelectorAll(`input[name="mgf-keep-${gi}"]`))
                                        .map(r => r.value)
                                        .filter(w => w !== keep);
                    if (drops.length === 0) return;
                    const res = window.DB.mergeInflections(keep, drops);
                    if (res && res.merged) { totalMerged += res.merged; groupsMerged++; }
                });

                close();
                if (totalMerged > 0) {
                    updateNotebookBadge();
                    window.MyWords?.refreshStudyList?.();
                    window.MyWords?.render?.();
                    showToast(`Merged ${totalMerged} form${totalMerged === 1 ? '' : 's'} into ${groupsMerged} word${groupsMerged === 1 ? '' : 's'}.`);
                } else {
                    showToast('Nothing merged.');
                }
            });
        }
    }

    function renderNotebookList(query) {
        const host = document.getElementById('notebook-list');
        if (!host) return;
        const nb    = window.DB?.loadNotebook?.() || [];
        const q     = String(query || '').toLowerCase().trim();
        const items = q
            ? nb.filter(w => (w.word || '').toLowerCase().includes(q) || (w.meaning || '').toLowerCase().includes(q))
            : nb;

        if (items.length === 0) {
            host.innerHTML = `<p style="color:var(--text-tertiary);font-size:13px;text-align:center;padding:20px 0">No words yet. Add some in My Words.</p>`;
            return;
        }
        // Newest first
        items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        host.innerHTML = items.slice(0, 500).map(w => `
            <div class="notebook-item">
                <div class="notebook-item-main">
                    <strong>${escapeHtml(w.word || '')}</strong>
                    ${w.phonetic ? `<span class="notebook-item-phon">${escapeHtml(w.phonetic)}</span>` : ''}
                </div>
                ${w.meaning ? `<div class="notebook-item-meaning">${escapeHtml(w.meaning)}</div>` : ''}
            </div>
        `).join('');
    }

    function bindNotebookHandlers() {
        document.getElementById('btn-notebook')?.addEventListener('click', openNotebook);
        document.getElementById('notebook-close')?.addEventListener('click', closeNotebook);
        document.getElementById('notebook-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'notebook-modal') closeNotebook();
        });
        document.getElementById('notebook-search')?.addEventListener('input', (e) => {
            renderNotebookList(e.target.value);
        });
    }

    // ─── Tab navigation ─────────────────────────────────────
    // Tab IDs in markup: my-words | speaking-coach | vocab-drill |
    // writing-lab | reader. Each maps to #view-<id>.
    function bindTabs() {
        const tabs   = document.querySelectorAll('.nav-tab[data-nav]');
        const views  = document.querySelectorAll('.app-view');

        // Restore the last-active tab from localStorage. Falls back to
        // whichever tab is marked .active in the HTML (My Words by default).
        // This is what fixes the "page jumps to My Words after a sync
        // reload" complaint — we now remember where the user was.
        try {
            const saved = window.DB?.getPref?.('active_tab', null);
            if (saved) {
                const tab = document.querySelector(`.nav-tab[data-nav="${saved}"]`);
                if (tab) {
                    tabs.forEach(x  => x.classList.toggle('active', x === tab));
                    views.forEach(v => v.classList.toggle('active', v.id === `view-${saved}`));
                }
            }
        } catch {}

        tabs.forEach(t => t.addEventListener('click', () => {
            const target = t.dataset.nav;
            tabs.forEach(x  => x.classList.toggle('active', x === t));
            views.forEach(v => v.classList.toggle('active', v.id === `view-${target}`));
            // Persist for next reload — a config-change reload, a
            // service-worker update, or a manual refresh will all
            // restore this tab.
            try { window.DB?.setPref?.('active_tab', target); } catch {}
            // Stop any ongoing playback when switching tabs
            stopSpeak();
            window.MyWords?.stopAutoplay?.();
            window.SentenceDrill?.stopListen?.();
        }));
    }

    // ─── Expressions sub-tabs (drill / sentences / …) ───────
    function bindExpressionSubTabs() {
        const tabs   = document.querySelectorAll('.sc-tabs .sc-tab[data-panel]');
        const panels = document.querySelectorAll('.sc-panel');

        // Restore the last-active sub-tab (Core / Mine / Phrases / …)
        try {
            const saved = window.DB?.getPref?.('active_subtab', null);
            if (saved) {
                const tab = document.querySelector(`.sc-tabs .sc-tab[data-panel="${saved}"]`);
                if (tab) {
                    tabs.forEach(x   => x.classList.toggle('active', x === tab));
                    panels.forEach(p => p.classList.toggle('active', p.id === saved));
                    // If we restored Mine, ensure its content is rendered
                    if (saved === 'sc-panel-mine') {
                        const el = document.getElementById('sc-panel-mine');
                        if (el && window.SentenceDrill?.initMine) window.SentenceDrill.initMine(el);
                    }
                }
            }
        } catch {}

        tabs.forEach(t => t.addEventListener('click', () => {
            const panelId = t.dataset.panel;
            tabs.forEach(x   => x.classList.toggle('active', x === t));
            panels.forEach(p => p.classList.toggle('active', p.id === panelId));
            // Persist for next reload
            try { window.DB?.setPref?.('active_subtab', panelId); } catch {}
            stopSpeak();
            window.SentenceDrill?.stopListen?.();
            // When switching into Mine, re-render so newly-added MyWords
            // entries show up immediately (initMine only runs at boot).
            if (panelId === 'sc-panel-mine') {
                const el = document.getElementById('sc-panel-mine');
                if (el && window.SentenceDrill?.initMine) window.SentenceDrill.initMine(el);
            }
        }));
    }

    // ─── HTML helpers ───────────────────────────────────────
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ─── Global click delegation for speakable surfaces ─────
    // Two surface conventions are recognized:
    //   1. .speak-btn[data-text] — explicit speaker buttons rendered next
    //      to words, options, sentence cards, etc.
    //   2. [data-speak] — entire speakable rows / boxes (English
    //      definitions, collocation chips, example sentences). Tapping
    //      anywhere in the box triggers speech, matching the visual
    //      affordance (cursor: pointer in CSS).
    // closest() walks up from the click target, so when a .speak-btn is
    // nested inside a [data-speak] container, the inner button wins —
    // which is correct: it preserves any per-button data-text override.
    function bindGlobalSpeakButtons() {
        document.addEventListener('click', (e) => {
            const el = e.target.closest('.speak-btn[data-text], [data-speak]');
            if (!el) return;
            const text = (el.dataset.text || el.dataset.speak || '').trim();
            if (!text) return;
            e.preventDefault();
            e.stopPropagation();
            speak(text);
        });
    }

    // ─── Active-session tracker ─────────────────────────────
    // Modules that run a multi-step interactive flow (autoplay, drilling,
    // analysis-in-flight) can call beginSession/endSession to suppress
    // auto-reload from the service worker. The SW update path consults
    // isStudySessionActive() before reloading so a fresh deploy doesn't
    // yank the user out of a sentence playback or a writing review.
    //
    // Activity is also implicitly tracked: any keystroke or text input
    // in the document marks the user as "active" for 60s afterward,
    // so reloads don't fire while they're mid-sentence in writing-lab
    // or typing into a drill input on PC.
    const _sessionTokens   = new Set();
    let   _lastActivityAt  = 0;
    const ACTIVITY_TIMEOUT = 60000;  // 60s after last keystroke = still "active"

    function _markActivity() { _lastActivityAt = Date.now(); }

    // Capture-phase listeners so we see input even when modules
    // stopPropagation. Passive so we never block typing.
    document.addEventListener('input',   _markActivity, { capture: true, passive: true });
    document.addEventListener('keydown', _markActivity, { capture: true, passive: true });

    function beginSession(label) {
        const token = label || `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        _sessionTokens.add(token);
        return token;
    }
    function endSession(token) {
        if (token) _sessionTokens.delete(token);
    }
    function isStudySessionActive() {
        // Explicit module-declared sessions
        if (_sessionTokens.size > 0)                          return true;
        // Module-specific activity: autoplay, sentence listen, TTS speaking
        if (window.MyWords?.isAutoplayActive?.())             return true;
        if (window.SentenceDrill?.isListenActive?.())         return true;
        try {
            if (window.speechSynthesis?.speaking)             return true;
        } catch {}
        // Neural TTS audio currently playing
        if (_neuralAudio && !_neuralAudio.paused)             return true;
        // Implicit: the user is currently focused in an editable field
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) {
            return true;
        }
        // Implicit: the user typed within the last ACTIVITY_TIMEOUT
        if (_lastActivityAt && (Date.now() - _lastActivityAt) < ACTIVITY_TIMEOUT) {
            return true;
        }
        return false;
    }

    // ─── Swipe gesture helper (v75) ─────────────────────────
    // Touch-only horizontal swipe detector for navigating between cards
    // (curated detail, mine detail, ref tab phrasing card, etc.). Designed
    // to coexist with vertical scrolling: only fires when horizontal travel
    // dominates and exceeds a clear threshold, so a casual vertical scroll
    // never misfires. Returns a teardown function the caller can use if
    // the element is later replaced.
    function bindSwipe(el, opts) {
        if (!el) return () => {};
        const onPrev    = opts?.onPrev || (() => {});
        const onNext    = opts?.onNext || (() => {});
        const minDist   = opts?.minDist   || 50;   // px of horizontal travel
        const maxOffAx  = opts?.maxOffAx  || 60;   // px of vertical travel — past this, treat as scroll
        const maxTime   = opts?.maxTime   || 600;  // ms — past this, treat as drag/long-press

        let sx = 0, sy = 0, sT = 0, tracking = false;

        function onStart(e) {
            // Ignore swipes that begin on an interactive control — the
            // existing button presses (prev/next, focus toggles, speak)
            // must keep working without being eaten by the swipe handler.
            const t = e.target;
            if (t && t.closest && t.closest('button, a, input, textarea, select')) {
                tracking = false;
                return;
            }
            const touch = e.touches && e.touches[0];
            if (!touch) return;
            sx = touch.clientX;
            sy = touch.clientY;
            sT = Date.now();
            tracking = true;
        }
        function onEnd(e) {
            if (!tracking) return;
            tracking = false;
            const touch = (e.changedTouches && e.changedTouches[0]);
            if (!touch) return;
            const dx = touch.clientX - sx;
            const dy = touch.clientY - sy;
            const dt = Date.now() - sT;
            if (dt > maxTime)                  return;
            if (Math.abs(dy) > maxOffAx)       return;
            if (Math.abs(dx) < minDist)        return;
            if (Math.abs(dx) < Math.abs(dy))   return;   // vertical-dominant — let it scroll
            if (dx > 0) onPrev();   // swipe right → previous (matches phone reading direction)
            else        onNext();
        }
        function onCancel() { tracking = false; }

        el.addEventListener('touchstart',  onStart,  { passive: true });
        el.addEventListener('touchend',    onEnd,    { passive: true });
        el.addEventListener('touchcancel', onCancel, { passive: true });

        return function teardown() {
            el.removeEventListener('touchstart',  onStart);
            el.removeEventListener('touchend',    onEnd);
            el.removeEventListener('touchcancel', onCancel);
        };
    }

    // ─── Public API ─────────────────────────────────────────
    window.App = {
        showToast,
        speak,
        stopSpeak,
        previewNeuralVoice,
        openSettings,
        closeSettings,
        openNotebook,
        closeNotebook,
        updateNotebookBadge,
        refreshStats,
        // Helpers other modules can use for safe HTML rendering
        escHtml: escapeHtml,
        escAttr: escapeAttr,
        // Study-session lifecycle (suppresses auto-reload during playback)
        beginSession,
        endSession,
        isStudySessionActive,
        // v75: shared swipe-to-navigate helper for card-based UIs
        bindSwipe
    };

    // ─── Profile name ───────────────────────────────────────
    // The display name is the user-chosen handle for this install.
    // It is purely cosmetic — the install's identity is PROFILE_ID,
    // which never changes, so renaming never orphans data.
    function getProfileName() {
        try { return localStorage.getItem('emp_profile_name') || ''; }
        catch { return ''; }
    }
    function setProfileName(name) {
        const clean = (name || '').trim().slice(0, 40) || 'My English Pro';
        try { localStorage.setItem('emp_profile_name', clean); } catch {}
        if (window.APP_CONFIG) window.APP_CONFIG.PROFILE_NAME = clean;
        return clean;
    }

    // First-run only: a brand-new install is flagged by config.js.
    // Shows a one-time modal asking what to call the user.
    function promptForNameIfNeeded() {
        let needs = false;
        try { needs = localStorage.getItem('emp_profile_needs_name') === '1'; } catch {}
        if (!needs) return;

        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id        = 'profile-name-modal';
        modal.innerHTML = `
            <div class="modal-card" style="max-width:360px">
                <div class="modal-header"><h2>Welcome</h2></div>
                <div class="modal-body">
                    <p class="settings-hint">What should this app call you? You can change it later in Settings.</p>
                    <input type="text" id="profile-name-input" class="settings-input"
                           placeholder="Your name" maxlength="40"
                           style="width:100%;margin-bottom:10px">
                    <button class="wl-btn-primary" id="profile-name-save" style="width:100%">Get started</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.classList.add('open');

        const input = modal.querySelector('#profile-name-input');
        const finish = () => {
            const name = setProfileName(input.value);
            try { localStorage.removeItem('emp_profile_needs_name'); } catch {}
            modal.classList.remove('open');
            setTimeout(() => modal.remove(), 250);
            showToast(`Welcome, ${name}!`);
        };
        modal.querySelector('#profile-name-save').addEventListener('click', finish);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(); });
        setTimeout(() => input.focus(), 50);
    }

    // ─── Boot ───────────────────────────────────────────────
    function boot() {
        try {
            // Verify required globals are actually present before initializing
            // modules — a missing global is a clearer error than a cascade of
            // undefined-method failures deep inside a feature.
            const missing = [];
            ['APP_CONFIG', 'DB', 'AIEngine', 'MyWords'].forEach(n => {
                if (!window[n]) missing.push(n);
            });
            if (missing.length) {
                console.error('[app] Missing required globals:', missing.join(', '));
                showToast('Startup error: ' + missing.join(', ') + ' not loaded.');
            }

            // Wire top-level UI first — these must work even if a module init fails.
            bindTabs();
            bindExpressionSubTabs();
            bindSettingsHandlers();
            bindSettingsTabs();
            bindNotebookHandlers();
            bindGlobalSpeakButtons();
            document.getElementById('btn-settings')?.addEventListener('click', openSettings);

            // Initialize feature modules. Wrap each in try/catch so one
            // broken module cannot prevent the others from loading.
            safeCall('MyWords',         () => window.MyWords?.init?.());
            safeCall('WritingLab',      () => window.WritingLab?.init?.());
            safeCall('VocabDrill',      () => window.VocabDrill?.init?.());
            safeCall('Reader',          () => window.Reader?.init?.());
            safeCall('SpeakingCoach',   () => window.SpeakingCoach?.init?.());
            safeCall('ExpressionCoach', () => {
                const el = document.getElementById('sc-panel-drill');
                if (el && window.ExpressionCoach?.init) window.ExpressionCoach.init(el);
            });
            safeCall('SentenceDrill', () => {
                const elCurated = document.getElementById('sc-panel-curated');
                const elMine    = document.getElementById('sc-panel-mine');
                if (elCurated && window.SentenceDrill?.initCurated) {
                    window.SentenceDrill.initCurated(elCurated);
                }
                if (elMine && window.SentenceDrill?.initMine) {
                    window.SentenceDrill.initMine(elMine);
                }
            });

            // Header stats
            refreshStats();

            // First-run: ask a brand-new install for a display name.
            promptForNameIfNeeded();

            console.log('[app] Boot complete.');
        } catch (err) {
            console.error('[app] Boot error:', err);
            showToast('Startup error \u2014 check console.');
        }
    }

    function safeCall(label, fn) {
        try { fn(); }
        catch (e) { console.error(`[app] ${label}.init failed:`, e); }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();
