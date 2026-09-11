(function initNewTabCore(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (globalScope) globalScope.QiyeNewTabCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createNewTabCore() {
  "use strict";

  const ACTIVITY_MAX_ITEMS = 200;
  const ACTIVITY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const DEFAULT_PREFERENCES = Object.freeze({ recordActivity: true, showFrequent: true, showRecent: true });
  const DEFAULT_BACKGROUND = Object.freeze({ mode: "default", imageUrl: "" });
  const BACKGROUND_MODES = Object.freeze(["default", "dawn", "dusk", "graphite", "image"]);
  const RECENT_SEARCH_MAX = 5;

  /** 决定新标签页本次应当渲染仪表盘还是交还浏览器默认页。 */
  function resolveNewTabMode(settings) {
    return settings?.newTabEnabled === true ? "dashboard" : "default";
  }
  const DASHBOARD_ICONS_BASE = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/";
  const DASHBOARD_ICON_ALIASES = Object.freeze({
    homeassistant: "home-assistant", "home-assistant": "home-assistant", ha: "home-assistant",
    "synology-dsm": "synology", "synology-photos": "synology", "true-nas": "truenas"
  });
  const KNOWN_BRANDS = [
    { pattern: /\bhome[\s_-]*assistant\b|家庭助理/i, slug: "home-assistant" },
    { pattern: /\bsynology\b|群晖/i, slug: "synology" }, { pattern: /\bjellyfin\b/i, slug: "jellyfin" },
    { pattern: /\bimmich\b/i, slug: "immich" }, { pattern: /\bnextcloud\b/i, slug: "nextcloud" },
    { pattern: /\bnavidrome\b/i, slug: "navidrome" }, { pattern: /\bproxmox\b/i, slug: "proxmox" },
    { pattern: /\bportainer\b/i, slug: "portainer" }, { pattern: /\btruenas\b|\btrue[\s_-]*nas\b/i, slug: "truenas" },
    { pattern: /\bqnap\b/i, slug: "qnap" }, { pattern: /\bemby\b/i, slug: "emby" }, { pattern: /\bplex\b/i, slug: "plex" }
  ];

  function text(value, fallback = "") { return typeof value === "string" && value.trim() ? value.trim() : fallback; }
  function httpUrl(value) { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.toString() : ""; } catch (_error) { return ""; } }
  function normalizeCatalog(payload) {
    const raw = payload?.catalog || payload || {};
    const groups = Array.isArray(raw.groups) ? raw.groups.flatMap((group) => {
      if (!group || typeof group !== "object" || !text(group.id)) return [];
      const items = Array.isArray(group.items) ? group.items.flatMap((item) => {
        const url = httpUrl(item?.url);
        if (!item || typeof item !== "object" || !text(item.id) || !url) return [];
        return [{ id: text(item.id), title: text(item.title, url), url, localUrl: httpUrl(item.localUrl),
          description: text(item.description), icon: text(item.icon), tags: Array.isArray(item.tags) ? item.tags.map((tag) => text(tag)).filter(Boolean) : [] }];
      }) : [];
      return [{ id: text(group.id), name: text(group.name, "未命名分组"), parentId: text(group.parentId), items }];
    }) : [];
    return { version: text(raw.version), settings: { title: text(raw.settings?.title, "栖页"),
      defaultSearchEngine: ["google", "bing", "duckduckgo"].includes(raw.settings?.defaultSearchEngine) ? raw.settings.defaultSearchEngine : "duckduckgo",
      localAccessHosts: Array.isArray(raw.settings?.localAccessHosts) ? raw.settings.localAccessHosts.map((host) => text(host).toLowerCase()).filter(Boolean) : [] }, groups };
  }
  function flattenCatalog(catalog) { return catalog.groups.flatMap((group) => group.items.map((item) => ({ ...item, groupId: group.id, groupName: group.name }))); }
  function findGroup(catalog, groupId) { return catalog?.groups?.find((group) => group.id === groupId) || null; }
  function childGroups(catalog, groupId) { return catalog?.groups?.filter((group) => group.parentId === groupId) || []; }
  function orderedGroupTree(catalog) {
    if (!catalog?.groups) return [];
    return catalog.groups.filter((group) => !group.parentId).flatMap((root) => [root, ...childGroups(catalog, root.id)]);
  }
  function groupEntries(catalog, groupId) {
    const group = findGroup(catalog, groupId);
    if (!group) return [];
    return [group, ...childGroups(catalog, groupId)].flatMap((sourceGroup) =>
      sourceGroup.items.map((item) => ({ group: sourceGroup, item })));
  }
  function groupTotalCount(catalog, groupId) { return groupEntries(catalog, groupId).length; }
  function displayGroups(catalog) {
    return orderedGroupTree(catalog).filter((group) => group.parentId ? group.items.length > 0 : groupTotalCount(catalog, group.id) > 0);
  }
  function chooseUrl(item, hostname, localHosts) {
    const host = String(hostname || "").toLowerCase();
    const local = localHosts.some((entry) => host === entry || (entry.startsWith(".") && host.endsWith(entry)));
    return local && item.localUrl ? item.localUrl : item.url;
  }
  function cardMetadata(item, targetUrl) {
    let hostname = "";
    try { hostname = new URL(targetUrl).hostname; } catch (_error) { /* The caller already validates catalog URLs. */ }
    const description = text(item?.description, hostname || targetUrl);
    const tags = Array.isArray(item?.tags) ? item.tags.map((tag) => text(tag)).filter(Boolean) : [];
    return { description, visibleTags: tags.slice(0, 2), remainingTagCount: Math.max(0, tags.length - 2), tags };
  }
  function searchItems(items, query) {
    const terms = text(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return items;
    return items.filter((item) => {
      const haystack = [item.title, item.url, item.description, item.groupName, ...(item.tags || [])].join(" ").toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }
  function normalizeHostname(hostname) { return text(hostname).replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase(); }
  function isPrivateIconHostname(hostname) {
    const host = normalizeHostname(hostname);
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".lan") ||
        host.endsWith(".home.arpa") || host.endsWith(".internal") || host === "::1" || /^(fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224;
  }
  function dashboardIconSlug(item) {
    const icon = text(item?.icon).toLowerCase();
    if (icon.startsWith("hl-")) {
      const requested = icon.slice(3).replace(/[^a-z0-9-]/g, "");
      if (requested) return DASHBOARD_ICON_ALIASES[requested] || requested;
    }
    const known = KNOWN_BRANDS.find((brand) => brand.pattern.test(text(item?.title)));
    return known?.slug || "";
  }
  function getIconCandidates(item) {
    if (!item || typeof item !== "object") return [];
    const candidates = [];
    const explicit = httpUrl(item.icon);
    if (explicit) candidates.push(explicit);
    const slug = dashboardIconSlug(item);
    if (slug) candidates.push(`${DASHBOARD_ICONS_BASE}${encodeURIComponent(slug)}.svg`);
    try {
      const host = normalizeHostname(new URL(item.url).hostname);
      if (host && !isPrivateIconHostname(host)) {
        const encoded = encodeURIComponent(host);
        candidates.push(`https://www.google.com/s2/favicons?domain=${encoded}&sz=128`, `https://icon.horse/icon/${encoded}`);
      }
    } catch (_error) { /* Explicit and mapped icons remain usable. */ }
    return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
  }
  function getInitials(title) { return Array.from(text(title, "?"))[0]?.toLocaleUpperCase() || "?"; }
  function sanitizeActivity(value, validIds, now = Date.now()) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.items)) return { schemaVersion: 1, items: [] };
    const oldest = now - ACTIVITY_MAX_AGE_MS;
    const seen = new Set();
    const items = [];
    for (const row of value.items) {
      if (!row || typeof row !== "object" || typeof row.itemId !== "string" || seen.has(row.itemId) || !validIds.has(row.itemId) ||
          !Number.isSafeInteger(row.count) || row.count < 1 || !Number.isFinite(row.lastActivatedAt) || row.lastActivatedAt < oldest || row.lastActivatedAt > now + 60_000) continue;
      seen.add(row.itemId);
      items.push({ itemId: row.itemId, count: row.count, lastActivatedAt: row.lastActivatedAt });
    }
    items.sort((a, b) => b.lastActivatedAt - a.lastActivatedAt);
    return { schemaVersion: 1, items: items.slice(0, ACTIVITY_MAX_ITEMS) };
  }
  class ActivityProvider {
    load() { throw new Error("ActivityProvider.load must be implemented"); }
    record() { throw new Error("ActivityProvider.record must be implemented"); }
    clear() { throw new Error("ActivityProvider.clear must be implemented"); }
  }
  class LocalClickProvider extends ActivityProvider {
    constructor(storage, key = "qiyeStartActivity") { super(); this.storage = storage; this.key = key; }
    load(validIds, now = Date.now()) { try { return sanitizeActivity(JSON.parse(this.storage.getItem(this.key) || "null"), validIds, now); } catch (_error) { return { schemaVersion: 1, items: [] }; } }
    record(itemId, validIds, now = Date.now()) {
      const activity = this.load(validIds, now);
      const row = activity.items.find((entry) => entry.itemId === itemId);
      if (row) { row.count += 1; row.lastActivatedAt = now; } else activity.items.push({ itemId, count: 1, lastActivatedAt: now });
      const clean = sanitizeActivity(activity, validIds, now);
      try { this.storage.setItem(this.key, JSON.stringify(clean)); } catch (_error) { /* Storage may be disabled. */ }
      return clean;
    }
    prune(validIds, now = Date.now()) { const clean = this.load(validIds, now); try { this.storage.setItem(this.key, JSON.stringify(clean)); } catch (_error) { /* Read-only fallback. */ } return clean; }
    clear() { try { this.storage.removeItem(this.key); } catch (_error) { /* Read-only fallback. */ } }
  }
  class BrowserHistoryProvider extends ActivityProvider {
    constructor() { super(); }
    load() { throw new Error("BrowserHistoryProvider is not available in the web build"); }
    record() { throw new Error("BrowserHistoryProvider is read-only and unavailable"); }
    clear() { return undefined; }
  }
  function activityItems(activity, itemMap, kind, limit = 6) {
    const rows = activity.items.slice().sort(kind === "frequent"
      ? (a, b) => b.count - a.count || b.lastActivatedAt - a.lastActivatedAt
      : (a, b) => b.lastActivatedAt - a.lastActivatedAt);
    return rows.flatMap((row) => itemMap.has(row.itemId) ? [{ item: itemMap.get(row.itemId), activity: row }] : []).slice(0, limit);
  }
  function dashboardFrequentItems(activity, itemMap, fallbackItems, limit = 6) {
    const selected = activityItems(activity, itemMap, "frequent", limit).map(({ item }) => item);
    const ids = new Set(selected.map(({ id }) => id));
    for (const item of fallbackItems || []) {
      if (selected.length >= limit) break;
      if (!ids.has(item.id)) { selected.push(item); ids.add(item.id); }
    }
    return selected.slice(0, limit);
  }
  function mergePreferences(value) { return { ...DEFAULT_PREFERENCES,
    recordActivity: value?.recordActivity !== false,
    showFrequent: value?.showFrequent !== false, showRecent: value?.showRecent !== false } }
  function searchUrl(query, engine) { const encoded = encodeURIComponent(query); return engine === "google" ? `https://www.google.com/search?q=${encoded}` : engine === "bing" ? `https://www.bing.com/search?q=${encoded}` : `https://duckduckgo.com/?q=${encoded}`; }

  /** 支持 !gh / !mdn 等命令式搜索，未命中命令时返回 null。 */
  function commandSearchUrl(query) {
    const match = text(query).match(/^!([a-z0-9]+)\s+(.+)$/i);
    if (!match) return null;
    const command = match[1].toLowerCase();
    const keyword = match[2];
    const encoded = encodeURIComponent(keyword);
    const targets = {
      gh: `https://github.com/search?q=${encoded}&type=repositories`,
      mdn: `https://developer.mozilla.org/search?q=${encoded}`,
      bd: `https://www.baidu.com/s?wd=${encoded}`,
      zh: `https://zh.wikipedia.org/w/index.php?search=${encoded}`,
      npm: `https://www.npmjs.com/search?q=${encoded}`
    };
    return targets[command] || null;
  }

  /** 分组名过滤：命中子分组时保留其父分组，返回匹配的两级树（保持显示顺序）。 */
  function filterGroupTree(catalog, query) {
    const groups = displayGroups(catalog);
    const keyword = text(query).toLocaleLowerCase();
    if (!keyword) return groups;
    const byId = new Map(groups.map((group) => [group.id, group]));
    const matched = new Set(groups.filter((group) => group.name.toLocaleLowerCase().includes(keyword)).map((group) => group.id));
    for (const group of groups) {
      if (!group.parentId) continue;
      if (matched.has(group.id) && group.parentId && byId.has(group.parentId)) matched.add(group.parentId);
      if (matched.has(group.parentId)) matched.add(group.id);
    }
    return groups.filter((group) => matched.has(group.id));
  }

  /** 返回固定六周的月历单元格，周一为每周第一天。 */
  function monthCalendar(year, month, today = new Date()) {
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - offset);
    return Array.from({ length: 42 }, (_unused, index) => {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
      return {
        year: date.getFullYear(), month: date.getMonth(), day: date.getDate(),
        currentMonth: date.getMonth() === month,
        today: date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
      };
    });
  }

  /** 从家庭服务、NAS、自托管或明确的影音服务分组中提取右栏快捷入口。 */
  function familyServiceItems(catalog, limit = 3) {
    const familyPattern = /家庭|家用|nas|home|self[\s_-]*host|自托管|自建服务|影音服务|媒体服务/i;
    const selected = [];
    const seen = new Set();
    for (const group of catalog?.groups || []) {
      if (!familyPattern.test(group.name)) continue;
      for (const { group: sourceGroup, item } of groupEntries(catalog, group.id)) {
        if (seen.has(item.id)) continue;
        selected.push({ ...item, groupId: sourceGroup.id, groupName: sourceGroup.name });
        seen.add(item.id);
        if (selected.length >= limit) return selected;
      }
    }
    return selected;
  }

  function mergeBackground(value) {
    const mode = BACKGROUND_MODES.includes(value?.mode) ? value.mode : DEFAULT_BACKGROUND.mode;
    const imageUrl = text(value?.imageUrl);
    const safeImageUrl = /^(?:https?:)?\/\//.test(imageUrl) || imageUrl.startsWith("/") ? imageUrl : "";
    return { mode, imageUrl: safeImageUrl };
  }

  function sanitizeRecentSearches(value) {
    if (!Array.isArray(value?.items)) return { schemaVersion: 1, items: [] };
    const seen = new Set();
    const items = [];
    for (const entry of value.items) {
      const query = text(entry).slice(0, 100);
      if (!query || seen.has(query)) continue;
      seen.add(query);
      items.push(query);
      if (items.length >= RECENT_SEARCH_MAX) break;
    }
    return { schemaVersion: 1, items };
  }

  function recordRecentSearch(value, query, limit = RECENT_SEARCH_MAX) {
    const clean = sanitizeRecentSearches(value);
    const keyword = text(query).slice(0, 100);
    if (!keyword) return clean;
    const items = [keyword, ...clean.items.filter((entry) => entry !== keyword)].slice(0, limit);
    return { schemaVersion: 1, items };
  }

  return { ACTIVITY_MAX_ITEMS, ACTIVITY_MAX_AGE_MS, DEFAULT_PREFERENCES, DEFAULT_BACKGROUND, BACKGROUND_MODES,
    RECENT_SEARCH_MAX, resolveNewTabMode, normalizeCatalog, flattenCatalog, findGroup, childGroups,
    orderedGroupTree, groupEntries, groupTotalCount, displayGroups, chooseUrl, cardMetadata, searchItems, isPrivateIconHostname,
    getIconCandidates, getInitials, sanitizeActivity, ActivityProvider, LocalClickProvider, BrowserHistoryProvider,
    activityItems, dashboardFrequentItems, mergePreferences, searchUrl, commandSearchUrl, filterGroupTree, monthCalendar, familyServiceItems,
    mergeBackground, sanitizeRecentSearches, recordRecentSearch };
});
