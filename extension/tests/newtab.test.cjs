const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../newtab-core.js");

test("resolveNewTabMode 默认关闭，仅显式开启才接管", () => {
  assert.equal(core.resolveNewTabMode(undefined), "default");
  assert.equal(core.resolveNewTabMode({}), "default");
  assert.equal(core.resolveNewTabMode({ newTabEnabled: false }), "default");
  assert.equal(core.resolveNewTabMode({ newTabEnabled: true }), "dashboard");
});

test("normalizeCatalog 只保留合法分组与 HTTP(S) 条目", () => {
  const catalog = core.normalizeCatalog({
    settings: { title: "栖页" },
    groups: [
      { id: "dev", name: "开发", items: [
        { id: "a", title: "MDN", url: "https://developer.mozilla.org/", description: "Web 开发文档", icon: "https://cdn.example.com/mdn.svg", tags: ["文档"] },
        { id: "b", title: "本地", url: "javascript:alert(1)", localUrl: "http://nas.local/panel" },
        { id: "c", title: "无地址", url: "" }
      ] },
      { id: "bad", name: "", items: [] }
    ]
  });
  assert.equal(catalog.settings.title, "栖页");
  assert.equal(catalog.groups.length, 2);
  assert.equal(catalog.groups[0].items.length, 1);
  assert.equal(catalog.groups[0].items[0].id, "a");
  assert.equal(catalog.groups[0].items[0].description, "Web 开发文档");
  assert.deepEqual(catalog.groups[0].items[0].tags, ["文档"]);
  assert.equal(catalog.groups[1].name, "未命名分组");
  assert.equal(catalog.groups[1].items.length, 0);
});

test("cardMetadata 优先展示介绍，无介绍时回退 hostname，并将标签压缩为前二项与余量", () => {
  assert.deepEqual(core.cardMetadata({ description: "开发者文档", tags: ["文档", "前端", "参考"] }, "https://developer.mozilla.org/zh-CN/"), {
    description: "开发者文档",
    visibleTags: ["文档", "前端"],
    remainingTagCount: 1,
    tags: ["文档", "前端", "参考"]
  });
  assert.deepEqual(core.cardMetadata({ description: "", tags: [] }, "https://docs.example.com/path"), {
    description: "docs.example.com",
    visibleTags: [],
    remainingTagCount: 0,
    tags: []
  });
});

test("sanitizeActivity 剔除失效、过期与重复行并限制上限", () => {
  const now = 1_700_000_000_000;
  const valid = new Set(["a", "b", "c"]);
  const activity = core.sanitizeActivity({
    schemaVersion: 1,
    items: [
      { itemId: "a", count: 2, lastActivatedAt: now - 1_000 },
      { itemId: "a", count: 9, lastActivatedAt: now - 2_000 },
      { itemId: "gone", count: 1, lastActivatedAt: now },
      { itemId: "b", count: 0, lastActivatedAt: now },
      { itemId: "c", count: 1, lastActivatedAt: now - 99 * 24 * 60 * 60 * 1000 }
    ]
  }, valid, now);
  assert.equal(activity.items.length, 1);
  assert.equal(activity.items[0].itemId, "a");
  assert.equal(activity.items[0].count, 2);
  assert.deepEqual(core.sanitizeActivity("bad", valid, now), { schemaVersion: 1, items: [] });
});

test("activityItems 常用按次数、最近按时间排序", () => {
  const activity = { schemaVersion: 1, items: [
    { itemId: "a", count: 1, lastActivatedAt: 300 },
    { itemId: "b", count: 5, lastActivatedAt: 100 },
    { itemId: "c", count: 2, lastActivatedAt: 200 }
  ] };
  const itemMap = new Map([
    ["a", { id: "a", title: "A" }], ["b", { id: "b", title: "B" }], ["c", { id: "c", title: "C" }]
  ]);
  assert.deepEqual(
    core.activityItems(activity, itemMap, "frequent", 2).map(({ item }) => item.id),
    ["b", "c"]
  );
  assert.deepEqual(
    core.activityItems(activity, itemMap, "recent", 2).map(({ item }) => item.id),
    ["a", "c"]
  );
});

test("点击记录首次写入、重复计数并可从存储恢复", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const valid = new Set(["a"]);
  const provider = new core.LocalClickProvider(storage, "activity");
  assert.equal(provider.record("a", valid, 1_700_000_000_000).items[0].count, 1);
  assert.equal(provider.record("a", valid, 1_700_000_001_000).items[0].count, 2);
  const restored = new core.LocalClickProvider(storage, "activity").load(valid, 1_700_000_002_000);
  assert.deepEqual(restored.items[0], { itemId: "a", count: 2, lastActivatedAt: 1_700_000_001_000 });
});

test("dashboardFrequentItems 无点击时回退默认分组前 6 项", () => {
  const empty = { schemaVersion: 1, items: [] };
  const itemMap = new Map();
  const fallback = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id: String(id), title: `T${id}` }));
  const rows = core.dashboardFrequentItems(empty, itemMap, fallback, 6);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].id, "1");
  assert.equal(rows[5].id, "6");
});

test("getIconCandidates 私网地址不发给第三方图标服务", () => {
  const candidates = core.getIconCandidates({ title: "NAS", url: "http://192.168.1.10:5000/", icon: "hl-synology" });
  assert.ok(candidates.length >= 1);
  assert.ok(candidates.every((url) => !url.includes("google.com/s2") && !url.includes("icon.horse")));
  const publicHost = core.getIconCandidates({ title: "MDN", url: "https://developer.mozilla.org/" });
  assert.ok(publicHost.some((url) => url.includes("google.com/s2")));
});

test("searchItems 按标题、网址、描述、分组与标签匹配全部词", () => {
  const items = [
    { id: "a", title: "TypeScript 手册", url: "https://ts.dev/", description: "", groupName: "开发", tags: ["语言"] },
    { id: "b", title: "图库", url: "https://pics.example.com/", description: "", groupName: "素材", tags: [] }
  ];
  assert.deepEqual(core.searchItems(items, "TS 手册").map((item) => item.id), ["a"]);
  assert.deepEqual(core.searchItems(items, "素材").map((item) => item.id), ["b"]);
  assert.equal(core.searchItems(items, "不存在").length, 0);
});

test("mergePreferences 默认开启记录与两个显示位", () => {
  assert.deepEqual(core.mergePreferences(), { recordActivity: true, showFrequent: true, showRecent: true });
  assert.deepEqual(core.mergePreferences({ recordActivity: false, showRecent: false }), { recordActivity: false, showFrequent: true, showRecent: false });
});

test("searchUrl 按引擎生成可搜索地址", () => {
  assert.match(core.searchUrl("栖页", "google"), /^https:\/\/www\.google\.com\/search\?q=/);
  assert.match(core.searchUrl("栖页", "bing"), /^https:\/\/www\.bing\.com\/search\?q=/);
  assert.match(core.searchUrl("栖页", "duckduckgo"), /^https:\/\/duckduckgo\.com\/\?q=/);
});

test("chooseUrl 本地访问入口优先选择局域网地址", () => {
  const item = { url: "https://nas.example.com/", localUrl: "http://192.168.1.10/" };
  assert.equal(core.chooseUrl(item, "localhost", ["localhost"]), "http://192.168.1.10/");
  assert.equal(core.chooseUrl(item, "tailscale.example.com", ["localhost"]), "https://nas.example.com/");
});

test("filterGroupTree 命中父级时保留子级，命中子级时保留父级", () => {
  const catalog = core.normalizeCatalog({ groups: [
    { id: "work", name: "工作", items: [{ id: "a", title: "邮箱", url: "https://mail.example.com/" }] },
    { id: "dev", parentId: "work", name: "开发工具", items: [{ id: "b", title: "GitHub", url: "https://github.com/" }] },
    { id: "life", name: "生活", items: [{ id: "c", title: "地图", url: "https://maps.example.com/" }] }
  ] });
  assert.deepEqual(core.filterGroupTree(catalog, "工作").map(({ id }) => id), ["work", "dev"]);
  assert.deepEqual(core.filterGroupTree(catalog, "开发").map(({ id }) => id), ["work", "dev"]);
});

test("monthCalendar 固定返回周一开始的六周月历", () => {
  const cells = core.monthCalendar(2026, 7, new Date(2026, 7, 17));
  assert.equal(cells.length, 42);
  assert.deepEqual(cells[0], { year: 2026, month: 6, day: 27, currentMonth: false, today: false });
  assert.equal(cells.find(({ today }) => today)?.day, 17);
  assert.equal(cells.filter(({ currentMonth }) => currentMonth).length, 31);
});

test("familyServiceItems 从家庭或 NAS 分组提取最多三个去重入口", () => {
  const catalog = core.normalizeCatalog({ groups: [
    { id: "home", name: "家庭服务", items: [{ id: "ha", title: "Home Assistant", url: "https://ha.example.com/" }] },
    { id: "nas", parentId: "home", name: "NAS", items: [
      { id: "dsm", title: "群晖", url: "https://dsm.example.com/" },
      { id: "media", title: "Jellyfin", url: "https://media.example.com/" },
      { id: "photo", title: "Immich", url: "https://photo.example.com/" }
    ] },
    { id: "work", name: "工作", items: [{ id: "mail", title: "邮箱", url: "https://mail.example.com/" }] }
  ] });
  assert.deepEqual(core.familyServiceItems(catalog).map(({ id }) => id), ["ha", "dsm", "media"]);
});

test("familyServiceItems 不会把普通自媒体分组误判为家庭服务", () => {
  const catalog = core.normalizeCatalog({ groups: [
    { id: "media", name: "自媒体平台", items: [{ id: "toutiao", title: "头条号", url: "https://mp.example.com" }] },
    { id: "nas", name: "NAS服务", items: [{ id: "photos", title: "照片", url: "https://photos.example.com" }] }
  ] });
  assert.deepEqual(core.familyServiceItems(catalog, 3).map((item) => item.id), ["photos"]);
});
