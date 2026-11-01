// Service Worker — הופך את האתר לאפליקציה שניתן להתקין (PWA)
// מטרה עיקרית: התקנה למסך הבית. לא שומר נתונים במטמון (ההודעות חייבות להיות עדכניות בזמן אמת).
const CACHE = 'wa-watcher-v1';
const SHELL = ['/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// רשת-תחילה: תמיד מנסים להביא טרי מהשרת (חשוב להודעות חיות), ורק אם אין רשת נופלים למטמון של האייקונים.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  // לא מתערבים ב-socket.io ובקריאות API — תמיד ישר לרשת
  if (req.method !== 'GET' || req.url.includes('/socket.io/') || req.url.includes('/api/') || req.url.includes('/media/')) {
    return;
  }
  e.respondWith(fetch(req).catch(() => caches.match(req)));
});
