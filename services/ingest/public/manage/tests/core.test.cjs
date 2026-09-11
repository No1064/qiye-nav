const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

const catalog = core.normalizeCatalog({
  version: "v1",
  groups: [
    {
      id: "0",
      name: "常用",
      items: [
        { id: "0", title: "OpenAI", url: "https://openai.com", tags: ["AI", "常用"] }
      ]
    },
    {
      id: "1",
      name: "NAS",
      itemCount: 1,
      items: [
        {
          id: "0",
          title: "Photos",
          url: "https://photos.example.com",
          localUrl: "http://192.168.1.20:5000",
          description: "家庭相册"
        }
      ]
    }
  ]
});

test("normalizeCatalog 兼容 catalog 包装并补齐数量", () => {
  const wrapped = core.normalizeCatalog({ catalog: {
    version: 7,
    settings: {
      title: "我的首页",
      subtitle: "常用入口",
      defaultSearchEngine: "google",
      localAccessHosts: ["nav.home.arpa"]
    },
    groups: [{ id: 2, name: "开发", items: [] }]
  } });
  assert.equal(wrapped.version, "7");
  assert.equal(wrapped.settings.title, "我的首页");
  assert.equal(wrapped.settings.defaultSearchEngine, "google");
  assert.deepEqual(wrapped.settings.localAccessHosts, ["nav.home.arpa"]);
  assert.equal(wrapped.groups[0].id, "2");
  assert.equal(wrapped.groups[0].itemCount, 0);
});

test("normalizeTags 去空格、去空值并去重", () => {
  assert.deepEqual(core.normalizeTags("开发, 常用,开发, "), ["开发", "常用"]);
});

test("分组内浏览只返回当前分组", () => {
  assert.deepEqual(core.listVisibleItems(catalog, "0", "").map((entry) => entry.item.title), ["OpenAI"]);
});

test("全局搜索覆盖标题、URL、标签、介绍和分组", () => {
  assert.deepEqual(core.listVisibleItems(catalog, "0", "家庭").map((entry) => entry.item.title), ["Photos"]);
  assert.deepEqual(core.listVisibleItems(catalog, "0", "ai").map((entry) => entry.item.title), ["OpenAI"]);
  assert.deepEqual(core.listVisibleItems(catalog, "0", "nas").map((entry) => entry.item.title), ["Photos"]);
});

test("两级分组按父子顺序展示，并使用完整路径参与搜索", () => {
  const nested = core.normalizeCatalog({ groups: [
    { id: "parent", name: "Acme", items: [] },
    { id: "other", name: "常用", items: [] },
    { id: "child", parentId: "parent", name: "Console", items: [
      { id: "site", title: "控制台", url: "https://console.example.com" }
    ] }
  ] });
  assert.equal(core.groupPath(nested, nested.groups[2]), "Acme / Console");
  assert.deepEqual(core.orderedGroupTree(nested).map(({ id }) => id), ["parent", "child", "other"]);
  assert.deepEqual(core.listVisibleItems(nested, "other", "acme").map(({ item }) => item.id), ["site"]);
  assert.equal(core.groupTotalCount(nested, "parent"), 1);
  assert.deepEqual(core.listVisibleItems(nested, "parent", "").map(({ group, item }) => [group.id, item.id]), [
    ["child", "site"]
  ]);
});

test("拖拽排序可把源 ID 移到目标 ID 之前", () => {
  assert.deepEqual(core.reorderIds(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(core.reorderIds(["a", "b"], "x", "a"), ["a", "b"]);
});

test("可访问排序按钮按 delta 移动并保护边界", () => {
  assert.deepEqual(core.moveId(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(core.moveId(["a", "b"], "a", -1), ["a", "b"]);
});

test("AI 分组参数留空时自动计算目标并使用默认容量", () => {
  const options = core.aiGroupingOptions({ targetGroupCount: "", minGroupSize: "", maxGroupSize: "" }, 420, "reorganize");
  assert.deepEqual(options.request, { minGroupSize: 5, maxGroupSize: 40 });
  assert.deepEqual(options.resolved, { targetGroupCount: 29, minGroupSize: 5, maxGroupSize: 40 });
  assert.equal(options.automatic, true);
});

test("AI 分组参数返回具体字段错误而不是统一阻断", () => {
  assert.throws(() => core.aiGroupingOptions({ targetGroupCount: "60" }, 50, "reorganize"), /不能超过/);
  assert.throws(() => core.aiGroupingOptions({ minGroupSize: "41", maxGroupSize: "40" }, 420, "reorganize"), /不能大于/);
  assert.throws(() => core.aiGroupingOptions({ minGroupSize: "1" }, 420, "reorganize"), /最小容量/);
});

test("常见 API 错误转换为清晰中文", () => {
  assert.equal(
    core.responseErrorMessage({ error: { code: "duplicate_url", message: "duplicate" } }, 409),
    "这个网址已经存在于导航站中"
  );
  assert.equal(core.responseErrorMessage({}, 401), "管理会话已失效，请重新登录");
  assert.equal(
    core.responseErrorMessage({ error: { message: { detail: "具体错误" } } }, 400),
    "具体错误"
  );
  assert.notEqual(core.responseErrorMessage({ error: {} }, 400), "[object Object]");
});

test("元数据 403 使用可继续保存的中文降级说明", () => {
  assert.equal(
    core.responseErrorMessage({ error: { code: "metadata_access_denied" } }, 422),
    "目标网站拒绝自动读取，你仍可手动填写后保存"
  );
});

test("AI 空响应与截断错误转换为可操作的中文提示", () => {
  assert.match(core.responseErrorMessage({ error: { code: "ai_empty_completion" } }, 502), /空内容/);
  assert.match(core.responseErrorMessage({ error: { code: "ai_timeout" } }, 504), /超时/);
  assert.match(core.responseErrorMessage({ error: { code: "ai_suggestion_stale" } }, 409), /网址/);
  assert.match(core.responseErrorMessage({ error: { code: "ai_group_plan_stale" } }, 409), /分组/);
  assert.match(core.responseErrorMessage({ error: { code: "ai_response_truncated" } }, 502), /截断/);
});
