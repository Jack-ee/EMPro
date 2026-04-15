// sw.js — English Master Pro Service Worker
const CACHE_NAME = 'emp-v5';
const ASSETS = [
    './',
    './index.html',
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
    './dictionary.js',
    './vocab.js',
    './stories.js',
    './i18n.js',
    './icon-192.png',
    './icon-512.png'
];

// Install — cache all assets
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(names =>
            Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
        )
    );
    self.clients.claim();
});

// Fetch — cache-first for local assets, network-first for API calls
self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // API calls: always go to network (AI providers, etc.)
    if (url.hostname !== location.hostname) {
        e.respondWith(fetch(e.request));
        return;
    }

    // Sync file + POST requests: always network (never cache)
    if (url.pathname.includes('emp-sync') || e.request.method !== 'GET') {
        e.respondWith(fetch(e.request));
        return;
    }

    // Local assets: cache-first
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request))
    );
});
