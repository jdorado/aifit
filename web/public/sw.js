const CACHE_NAME = 'aifit-__AIFIT_BUILD_ID__';
const ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/aifit-blue-192.png',
    '/aifit-blue-512.png',
    '/aifit-blue-apple-touch.png',
    '/aifit-blue-favicon-32.png',
    '/aifit-blue-favicon-16.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => Promise.all(
            ASSETS.map((url) => cache.add(url).catch(() => undefined))
        ))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        ))
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') {
        return;
    }

    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) {
        return;
    }

    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .catch(() => caches.match('/index.html'))
        );
        return;
    }

    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
