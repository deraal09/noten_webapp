/*
 * Service Worker der Notenverwaltung. Er macht die Seite als App installierbar (Chrome/Edge verlangen
 * einen Service Worker mit fetch-Handler) und zeigt ohne Verbindung eine kurze Hinweisseite.
 *
 * Bewusst KEIN Caching von Seiten oder Daten: Noten und Schülerdaten dürfen weder offline noch nach
 * dem Abmelden auf dem Gerät zwischengespeichert vorliegen. Gecacht wird nur die Offline-Hinweisseite.
 */
const CACHE = 'noten-offline-v1';
const OFFLINE_URL = '/static/pwa/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE_URL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(namen.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return; // alles andere geht unverändert ans Netz
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
