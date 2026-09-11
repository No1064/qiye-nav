"use strict";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => /^qiye-(?:home-shell|start-shell|catalog)-/.test(key))
      .map((key) => caches.delete(key)));
    await self.registration.unregister();
    await self.clients.claim();
  })());
});
