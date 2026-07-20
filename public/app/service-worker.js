// Radioller PWA Service Worker
// BASE is derived from the SW's own URL so it works at / (dev) and /radio/ (prod).
const BASE = self.location.pathname.replace(/service-worker\.js$/, '');

const CACHE = 'radioller-v1';
const SHELL = [
    BASE,
    BASE + 'css/tokens.css',
    BASE + 'css/app.css',
    BASE + 'js/app.js',
    BASE + 'js/player.js',
    BASE + 'fonts/OpenSans-Regular.ttf',
    BASE + 'fonts/OpenSans-Medium.ttf',
    BASE + 'fonts/OpenSans-Semibold.ttf',
    BASE + 'icons/appicon.svg',
    BASE + 'manifest.webmanifest',
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    // Only handle GET requests for same-origin resources
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);
    if (url.origin !== location.origin) return;

    // API calls — network only (no caching)
    if (url.pathname.startsWith(BASE + 'api/')) return;

    // Blazor WASM assets — never cache; Blazor manages these with fingerprints
    if (url.pathname.startsWith(BASE + '_framework/')) return;

    // Hard refresh (Ctrl-R / Ctrl-Shift-R) — bypass SW cache so the browser
    // fetches fresh assets and Blazor WASM can boot cleanly
    if (e.request.cache === 'reload' || e.request.cache === 'no-store') return;

    // App shell + data files — cache-first with network fallback
    e.respondWith(
        caches.match(e.request).then(cached => {
            const net = fetch(e.request).then(res => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return res;
            });
            if (cached) {
                // Return cached response immediately; background fetch updates the cache.
                // Suppress the unhandled rejection so the console stays clean.
                net.catch(() => {});
                return cached;
            }
            return net;
        })
    );
});
