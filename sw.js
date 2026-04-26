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

const CACHE_NAME = 'emp-v66';
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
