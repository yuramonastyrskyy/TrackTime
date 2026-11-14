// Offline cache: the app works at the velodrome without internet after one visit.
const VERSION = 'tracktime-v4';
const CLIPS = [...Array(100).keys()].map((n) => `audio/en/${n}.m4a`).concat(['point', 'minute', 'start'].map((w) => `audio/en/${w}.m4a`));
const SHELL = ['./', 'index.html', 'styles.css', 'js/app.js', 'js/detector.js', 'js/speech.js', 'js/recorder.js', 'js/glsampler.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', ...CLIPS];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first, so updates show up straight away; the cache covers offline use.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
