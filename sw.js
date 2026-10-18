// Офлайн-режим: оболочка приложения и библиотеки кэшируются, перевод всегда идёт в сеть.
const VERSION = 'readr-v6';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/icon-maskable.png',
  'js/app.js', 'js/appearance.js', 'js/db.js', 'js/importers.js', 'js/install.js', 'js/langs.js', 'js/layout.js', 'js/llm.js',
  'js/library.js', 'js/reader.js', 'js/review.js', 'js/sample.js', 'js/settings-view.js', 'js/state.js',
  'js/stats.js', 'js/sync.js', 'js/terms.js', 'js/texts.js', 'js/tokenize.js', 'js/translate.js', 'js/tts.js',
  'js/util.js', 'js/words.js',
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  // cache: 'reload' — мимо HTTP-кэша, иначе новая версия может закэшировать старые файлы.
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'readr-cdn').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open('readr-cdn').then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Свои файлы: отдаём из кэша сразу, обновляем в фоне.
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const hit = await c.match(key, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => {
      if (res.ok) c.put(key, res.clone());
      return res;
    }).catch(() => hit);
    return hit || fresh;
  }));
});
