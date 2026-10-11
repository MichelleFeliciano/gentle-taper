// Service worker: (1) makes the app work offline by caching its files, (2) shows push notifications.
// Bump the CACHE name whenever files change so old copies are replaced.
const CACHE = 'gentle-taper-v18';
// The "app shell": files cached when the worker installs. (Google Fonts are cached on first use below.)
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

// Install: cache the app shell, and take over immediately instead of waiting for old tabs to close.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

// Activate: delete caches left by older versions, then control any open pages.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first, refreshing in the background so edits show up on the next open.
// Only GET requests are handled; the reminder/backup service uses POST and is untouched.
// ignoreSearch lets './?quick=coffee' (home-screen shortcut) match the cached page.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

// Tapping a notification brings the app forward (or opens it).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow('./');
    })
  );
});

// Silent push from the reminder service: show a fixed, friendly notification.
// The push carries no payload, so the text is fixed. Browsers require a visible notification for every push.
// Using the same `tag` as the on-device reminder means one replaces the other instead of stacking.
self.addEventListener('push', e => {
  e.waitUntil(self.registration.showNotification('Gentle Taper', {
    body: 'Time to log your drinks and how you’re feeling 🌿',
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'taper-daily',
  }));
});
