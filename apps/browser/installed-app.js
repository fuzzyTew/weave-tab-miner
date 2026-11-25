// apps/browser/installed-app.js — lets the page install like an app (a progressive web app,
// "PWA") where it is served from a site: the manifest names it and its icons, and the
// service worker (apps/browser/pwa/service-worker.js) keeps a copy for opening offline.
// A downloaded copy opened from a file cannot have a service worker, and needs none.

export class InstalledApp {
  static SERVICE_WORKER = 'service-worker.js';

  /** Registers the service worker when served over http(s); says so if the browser refuses. */
  static async register(log) {
    if (!/^https?:$/.test(location.protocol) || !navigator.serviceWorker) return;
    try {
      await navigator.serviceWorker.register(InstalledApp.SERVICE_WORKER);
    } catch (error) {
      log(`this page cannot be installed as an app here: ${error.message}`, 'warn');
    }
  }
}
