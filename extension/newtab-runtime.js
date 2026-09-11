(function initializeQiyeRuntime() {
  "use strict";

  const isExtension = Boolean(globalThis.chrome?.storage?.local && globalThis.chrome?.runtime?.id);

  async function storageGet(key) {
    if (isExtension) {
      try { return (await chrome.storage.local.get(key))[key] ?? null; } catch (_error) { return null; }
    }
    try { return localStorage.getItem(key); } catch (_error) { return null; }
  }

  async function storageSet(key, value) {
    if (isExtension) {
      try { await chrome.storage.local.set({ [key]: value }); } catch (_error) { /* Read-only fallback. */ }
      return;
    }
    try { localStorage.setItem(key, value); } catch (_error) { /* Read-only fallback. */ }
  }

  async function storageRemove(key) {
    if (isExtension) {
      try { await chrome.storage.local.remove(key); } catch (_error) { /* Read-only fallback. */ }
      return;
    }
    try { localStorage.removeItem(key); } catch (_error) { /* Read-only fallback. */ }
  }

  async function openSettings() {
    if (isExtension) {
      await chrome.runtime.openOptionsPage();
      return;
    }
    window.open("/manage/", "_blank", "noopener,noreferrer");
  }

  async function restoreDefaultNewTab() {
    if (!isExtension) return false;
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab && tab.id != null) {
        await chrome.tabs.update(tab.id, { url: "chrome://newtab" });
        return true;
      }
    } catch (_error) { /* Fall through to location navigation. */ }
    try {
      window.location.replace("chrome://newtab");
      return true;
    } catch (_error) { return false; }
  }

  async function retireLegacyWebShell() {
    if (isExtension || !("serviceWorker" in navigator)) return;
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations
        .filter((registration) => registration.scope === `${location.origin}/`)
        .map((registration) => registration.unregister()));
      if ("caches" in globalThis) {
        const keys = await caches.keys();
        await Promise.all(keys
          .filter((key) => /^qiye-(?:home-shell|start-shell|catalog)-/.test(key))
          .map((key) => caches.delete(key)));
      }
    } catch (_error) { /* Legacy cache cleanup is best effort. */ }
  }

  globalThis.QiyeRuntime = Object.freeze({
    isExtension,
    defaultSettings: isExtension ? {} : { apiBaseUrl: location.origin, newTabEnabled: true },
    storageGet,
    storageSet,
    storageRemove,
    openSettings,
    restoreDefaultNewTab,
    retireLegacyWebShell
  });
})();
