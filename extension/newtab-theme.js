(function initializeQiyeTheme() {
  "use strict";

  const STORAGE_KEY = "qiye.theme";
  const VALID_THEMES = new Set(["auto", "light", "dark"]);
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  function normalize(value) {
    return VALID_THEMES.has(value) ? value : "auto";
  }

  function readPreference() {
    try { return normalize(localStorage.getItem(STORAGE_KEY)); } catch (_error) { return "auto"; }
  }

  function resolvedTheme(preference) {
    return preference === "auto" ? (media.matches ? "dark" : "light") : preference;
  }

  function apply(preference, persist) {
    const normalized = normalize(preference);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, normalized); } catch (_error) { /* Storage may be disabled. */ }
    }
    document.documentElement.dataset.themePreference = normalized;
    document.documentElement.dataset.theme = resolvedTheme(normalized);
    document.querySelector?.('meta[name="theme-color"]')?.setAttribute(
      "content",
      document.documentElement.dataset.theme === "dark" ? "#111215" : "#ffffff"
    );
    document.dispatchEvent(new CustomEvent("qiye:themechange", {
      detail: { preference: normalized, resolved: document.documentElement.dataset.theme }
    }));
    return normalized;
  }

  media.addEventListener("change", () => {
    if (readPreference() === "auto") apply("auto", false);
  });

  globalThis.QiyeTheme = Object.freeze({
    getPreference: readPreference,
    setPreference: (preference) => apply(preference, true),
    resolve: resolvedTheme
  });
  apply(readPreference(), false);
})();
