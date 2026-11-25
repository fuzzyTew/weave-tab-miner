// apps/browser/pwa/service-worker.js — lets the installed page open without a connection.
// It keeps a copy of the page and its icons; the page is fetched fresh whenever the network
// answers (so updates arrive on the next open) and the kept copy is used when it does not.
// Only this site's own files pass through here: gateways, nodes and VDF servers do not.

class PageCache {
  static NAME = 'weave-tab-miner-page';
  static FILES = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

  install() {
    return caches.open(PageCache.NAME).then((cache) => cache.addAll(PageCache.FILES));
  }

  /** Network first for this site's files, the kept copy when offline; others untouched. */
  respond(event) {
    const request = event.request;
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(PageCache.NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request).then((kept) => kept ?? caches.match('./'))));
  }

  run() {
    self.addEventListener('install', (event) => event.waitUntil(this.install().then(() => self.skipWaiting())));
    self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', (event) => this.respond(event));
  }
}

new PageCache().run();
