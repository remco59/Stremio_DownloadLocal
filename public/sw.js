// Makes the web UI installable. Nothing is cached: the pages sit behind a login and the API and video must always
// be live, so the only thing this does is show a short note instead of the browser's error page when offline.
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>Offline</title>
<body style="font:15px/1.45 system-ui,sans-serif;background:#0f1115;color:#e6e8ec;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center">
<main><h1 style="font-size:19px;margin:0 0 8px">You are offline</h1><p style="color:#8b93a1;margin:0 0 16px">Local Download &amp; Watch needs a connection to your server.</p>
<button onclick="location.reload()" style="font:inherit;font-weight:600;color:#fff;background:#6c50f5;border:0;border-radius:8px;padding:10px 14px">Try again</button></main>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
