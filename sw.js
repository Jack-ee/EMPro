// sw.js — English Master Pro Service Worker
// v12 — fixes PWA install on mobile:
//   • v11: removed phantom files (dictionary.js, vocab.js, stories.js,
//     i18n.js) that were breaking cache.addAll().
//   • v12: added maskable icon entries for proper Android webapk build.
//     The previous icons were JPEG-in-PNG files (wrong MIME and wrong
//     dimensions), which made Android silently fail the install-to-
//     launcher step after reporting "installed successfully".
//   • Resilient install: individual cache.put calls so any single missing
//     file is logged as a warning, not a fatal error.
//   • Network-first for local assets (picks up deploys without a hard reload).
// v15 — cache-busting version strings on asset URLs:
//   • index.html now references style.css?v=15, app.js?v=15, etc.
//   • Offline fallback uses { ignoreSearch: true } so a versioned request
//     like style.css?v=15 still matches the plain style.css entry cached
//     at install time. This keeps the app working offline across deploys.

// v93 — audio pack playback:
//   • speak() now plays English words from the downloaded pack when a
//     clip exists — no key, proxy, or network for covered words —
//     falling back to the neural and then the device voice otherwise.
//   • each play picks a random voice from the chosen set, so a word
//     sounds different on repeat during autoplay.
//   • removing a notebook word also deletes its pack audio.

// v92 — audio pack: word limit and a more compact Voice panel:
//   • a "Words/build" field caps how many words each cloud build
//     generates; it is written into the exported word list and the
//     generator reads it from a "# limit:" header.
//   • Settings → Voice is tightened: two-column auto-pronounce, side
//     by side pack buttons, shorter help text.

// v91 — audio pack: voice picker, coverage, word-list export:
//   • Settings → Voice gains voice checkboxes, a coverage line
//     (how many words still lack pronunciation), and an Export word
//     list button that writes wordlist.txt with the chosen voices.
//   • the pack generator reads voices from a "# voices:" header in
//     the word list, so voices are chosen in the app, not source.

// v90 — pre-generated pronunciation pack:
//   • new module tts-pack.js: downloads a bundled pack of word audio
//     into a dedicated, never-evicted IndexedDB store ('emp-tts-pack').
//   • the pack is fetched through the existing Cloudflare Worker,
//     which now also relays the GitHub Release asset (Release assets
//     send no CORS header, so a direct browser fetch is blocked).
//   • Settings → Voice gains a "Download audio pack" button.

// v89 — stop syncing the OpenAI key:
//   • the OpenAI TTS key is a credential and is now excluded
//     from the Gist sync payload (like the AI provider key), so
//     it is never written to GitHub. Removes a key-exposure path.

// v88 — honest neural voice test:
//   • the Test button now uses a unique sentence each run so
//     the proxy edge cache can't serve a stale clip — a passing
//     test now genuinely means the OpenAI key works.

// v87 — OpenAI key sanitization:
//   • strip non-ASCII characters (zero-width spaces, smart
//     quotes, full-width letters) from the key before it is put
//     in the Authorization header — fixes the fetch() error
//     'String contains non ISO-8859-1 code point'.

// v86 — bilingual voice routing:
//   • Chinese text always uses the device's native Chinese
//     voice; the OpenAI neural voice is reserved for English.

// v85 — neural TTS via CORS proxy:
//   • OpenAI blocks direct browser calls; TTS requests now go
//     through a user-supplied proxy URL (a Cloudflare Worker).
//   • new 'TTS proxy URL' field in Settings → Voice.

// v84 — neural TTS debug output:
//   • [tts] console logs for voice resolution, HTTP status, and
//     byte size (auto-captured by the debug panel log).
//   • Test button shows a visible status line: voice + KB size.

// v83 — neural TTS diagnostics:
//   • 'Test neural voice' now reports the real outcome (works,
//     or the specific error) instead of silently downgrading.
//   • a neural failure during playback shows a one-time toast so
//     a silent fallback no longer looks like 'the switch does nothing'.

// v82 — neural TTS reliability:
//   • synthesised clips persist in IndexedDB — each text is
//     fetched from OpenAI at most once per device, then reused
//     across reloads and offline.
//   • transient failures (429 / network) retried with backoff
//     before falling back, fixing the mixed-voice autoplay.

// v81 — settings redesign:
//   • Settings split into 5 tabs (General / Voice / AI / Sync /
//     Data) so it no longer scrolls as one long page.

// v80 — multi-user:
//   • per-install PROFILE_ID (no data / Gist collision between
//     users); first run asks for a display name.
//   • non-owner installs see only a demo subset of Expressions;
//     the Ref tab stays shared in full.

// v79 — neural TTS:
//   • optional OpenAI gpt-4o-mini-tts voice engine for far less
//     robotic sentence playback; device voice remains the offline
//     fallback. Settings → Voice → Voice engine.

// v78 — batch paste-back fix:
//   • enriched entries now carry an INPUT field echoing the original
//     word, so an inflected word ('squeezed') updates its own row
//     instead of leaving an orphan when the AI returns the lemma.
//   • wider irregular-verb / Latin-plural lemma table.

const CACHE_NAME = 'emp-v93';
const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './style.css',
    './expressions-coach.css',
    './config.js',
    './db.js',
    './ai-engine.js',
    './my-words.js',
    './writing-lab.js',
    './vocab-drill.js',
    './reader.js',
    './speaking-coach.js',
    './expressions-data.js',
    './expressions-coach.js',
    './sentence.js',
    './sentence-drill.js',
    './sync.js',
    './tts-pack.js',
    './app.js',
    './debug-panel.js',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-192.png',
    './icon-maskable-512.png'
];

// Install — cache assets individually so a single failure doesn't kill install.
// This is essential for PWA installability: if install fails, the SW never
// activates, and Chrome on Android won't offer the "Install" prompt.
self.addEventListener('install', (e) => {
    e.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await Promise.all(ASSETS.map(async (url) => {
            try {
                const resp = await fetch(url, { cache: 'reload' });
                if (resp && resp.ok) {
                    await cache.put(url, resp);
                } else {
                    console.warn('[SW] Skipped (bad response):', url, resp && resp.status);
                }
            } catch (err) {
                console.warn('[SW] Skipped (fetch failed):', url, err && err.message);
            }
        }));
    })());
    self.skipWaiting();
});

// Activate — clean old caches, take control immediately
self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

// Fetch — network-first for local GETs, fall back to cache when offline.
// Cross-origin requests (API providers, GitHub Gist, Google Fonts, Google TTS)
// pass straight through — never cached, never intercepted.
self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Cross-origin: pass through untouched
    if (url.hostname !== location.hostname) {
        return;  // let browser handle it
    }

    // Any non-GET (or sync file): never cache
    if (e.request.method !== 'GET' || url.pathname.includes('emp-sync')) {
        e.respondWith(fetch(e.request));
        return;
    }

    // Local GETs: network-first, fall back to cache when offline
    e.respondWith((async () => {
        try {
            const fresh = await fetch(e.request);
            if (fresh && fresh.ok && fresh.type !== 'opaque') {
                const cache = await caches.open(CACHE_NAME);
                cache.put(e.request, fresh.clone()).catch(() => {});
            }
            return fresh;
        } catch {
            // Offline fallback: ignore ?v=N query strings so a request for
            // style.css?v=15 still matches the plain style.css entry cached
            // at install time. Without ignoreSearch we'd miss every asset
            // after the first cache-bust and break offline mode.
            const cached = await caches.match(e.request, { ignoreSearch: true });
            if (cached) return cached;
            if (e.request.destination === 'document') {
                return (await caches.match('./index.html')) || new Response('Offline', { status: 504 });
            }
            return new Response('Offline', { status: 504 });
        }
    })());
});

// Support a manual "activate new SW" message from the page
self.addEventListener('message', (e) => {
    if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
