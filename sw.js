// Service worker: (1) makes the app work offline by caching its files, (2) shows push notifications.
// RELEASES: bump the number in CACHE with every release. It must equal VERSION in app.js (a test checks this). A new worker
// downloads the new files into a new cache and then WAITS; the app shows an "Update now" banner, and only when the user taps it
// (or closes every tab) does the new version take over. That way the page and its files are always from the same version.
const CACHE = 'gentle-taper-v19';
// The "app shell": files cached when the worker installs. (Google Fonts are cached on first use below.)
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

// Install: download every app file fresh (bypassing the browser's HTTP cache) into the new cache. No skipWaiting here on purpose.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(a => new Request(a, { cache: 'reload' })))));
});

// The page sends this when the user taps "Update now": take over from the old version.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Activate: delete caches left by older versions, then control any open pages.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Our own files: served straight from this version's cache (exactly what was installed), falling back to the network.
// Anything else (Google Fonts): cache-first too, but refreshed in the background.
// Only GET requests are handled; the reminder/backup service uses POST and is untouched.
// ignoreSearch lets './?quick=coffee' (home-screen shortcut) match the cached page.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const mine = new URL(e.request.url).origin === self.location.origin;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => {
      if (hit && mine) return hit;
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
