// Field PWA service worker: caches the app shell so the driver screen opens offline. API calls are never cached;
// queued actions live in IndexedDB (see app/field) and are replayed through /api/v1/sync with client_op_id (idempotent).
const SHELL = 'rppc-shell-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/field', '/icon.svg', '/manifest.webmanifest']))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && (url.pathname.startsWith('/_next/static') || url.pathname === '/field')) caches.open(SHELL).then((c) => c.put(e.request, r.clone())); return r; })
    .catch(() => caches.match(e.request).then((m) => m || caches.match('/field'))));
});
self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : { title: 'RPPC', body: '' };
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, data: { link: d.link } }));
});
self.addEventListener('notificationclick', (e) => { e.notification.close(); e.waitUntil(self.clients.openWindow(e.notification.data?.link || '/')); });
