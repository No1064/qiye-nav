const test = require("node:test");
const assert = require("node:assert/strict");
const shared = require("../shared.js");

test("normalizeApiBaseUrl 保留子路径并移除尾部斜杠", () => {
  assert.equal(shared.normalizeApiBaseUrl(" https://nav.example.com/ingest/ "), "https://nav.example.com/ingest");
  assert.equal(shared.normalizeApiBaseUrl("http://localhost:8787/"), "http://127.0.0.1:8787");
});

test("normalizeApiBaseUrl 拒绝危险或不支持的地址", () => {
  assert.throws(() => shared.normalizeApiBaseUrl("file:///tmp/api"), /HTTP/);
  assert.throws(() => shared.normalizeApiBaseUrl("https://user:secret@example.com"), /用户名或密码/);
  assert.throws(() => shared.normalizeApiBaseUrl("https://example.com?a=1"), /查询参数/);
});

test("buildPermissionOrigin 只返回配置服务的 origin", () => {
  assert.equal(shared.buildPermissionOrigin("https://nav.example.com/api"), "https://nav.example.com/*");
  assert.equal(shared.buildPermissionOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787/*");
});

test("网址校验和规范化只接受 HTTP(S) 并保留完整 hash 路由", () => {
  assert.equal(shared.isSavableUrl("https://example.com/docs#part"), true);
  assert.equal(shared.isSavableUrl("chrome://extensions"), false);
  assert.equal(shared.isSavableUrl("javascript:alert(1)"), false);
  assert.equal(shared.canonicalizeUrl("https://example.com/docs#/part"), "https://example.com/docs#/part");
});

test("分组响应兼容数组、groups 和 data 包装", () => {
  assert.deepEqual(shared.extractGroups(["常用"]), [{ id: "常用", name: "常用" }]);
  assert.deepEqual(shared.extractGroups({ groups: [{ id: "dev", name: "开发" }] }), [{ id: "dev", name: "开发" }]);
  assert.deepEqual(shared.extractGroups({ data: [{ slug: "nas", title: "NAS" }] }), [{ id: "nas", name: "NAS" }]);
  assert.deepEqual(shared.extractGroups({ groups: [
    { id: "company", name: "公司" },
    { id: "project", name: "项目", parentId: "company" }
  ] }), [
    { id: "company", name: "公司" },
    { id: "project", name: "公司 / 项目", parentId: "company" }
  ]);
});

test("退避时长指数增长并限制在六小时附近", () => {
  assert.equal(shared.calculateBackoffMs(0, 0.5), 30_000);
  assert.equal(shared.calculateBackoffMs(1, 0.5), 60_000);
  assert.ok(shared.calculateBackoffMs(30, 0.5) <= 6 * 60 * 60 * 1000);
});

test("endpoint 正确拼接 API 子路径", () => {
  assert.equal(
    shared.endpoint("https://nav.example.com/ingest/", "/api/v1/groups"),
    "https://nav.example.com/ingest/api/v1/groups"
  );
});

test("结构化服务错误只显示 message，不会变成对象字符串", () => {
  assert.equal(shared.responseError({ error: { code: "invalid_url", message: "地址无效" } }), "地址无效");
  assert.equal(shared.responseError({ error: { code: "broken" } }, "保存失败"), "保存失败");
});

test("Safari 环境检测：无 chrome.engines.webKit 时不是 Safari", () => {
  assert.equal(shared.isSafari(), false);
});

test("normalizeApiBaseUrl 将 localhost 规范化为 127.0.0.1", () => {
  assert.equal(shared.normalizeApiBaseUrl("http://localhost:8787"), "http://127.0.0.1:8787");
  assert.equal(shared.normalizeApiBaseUrl("http://localhost:8080/api/"), "http://127.0.0.1:8080/api");
  // 非 localhost 主机不受影响。
  assert.equal(shared.normalizeApiBaseUrl("https://nav.example.com/api"), "https://nav.example.com/api");
});

test("shouldUseHostPermissions：Chromium 且权限 API 可用时为 true", () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    permissions: {
      contains: () => Promise.resolve(true),
      request: () => Promise.resolve(true),
      remove: () => Promise.resolve()
    }
  };
  try {
    assert.equal(shared.shouldUseHostPermissions(), true);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("shouldUseHostPermissions：Safari 环境返回 false（跳过 origins 权限）", () => {
  const previousChrome = globalThis.chrome;
  // Safari 暴露 chrome.engines.webKit，同时也有 permissions API，但应跳过 origins 权限。
  globalThis.chrome = {
    engines: { webKit: {} },
    permissions: {
      contains: () => Promise.resolve(true),
      request: () => Promise.resolve(true),
      remove: () => Promise.resolve()
    }
  };
  try {
    assert.equal(shared.isSafari(), true);
    assert.equal(shared.hasPermissionsApi(), true);
    assert.equal(shared.shouldUseHostPermissions(), false);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("shouldUseHostPermissions：无权限 API 时返回 false", () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { engines: { webKit: {} } };
  try {
    assert.equal(shared.shouldUseHostPermissions(), false);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("safePermissionsContains 在权限 API 缺失时返回 fallback", async () => {
  const previousChrome = globalThis.chrome;
  delete globalThis.chrome;
  try {
    assert.equal(await shared.safePermissionsContains(undefined, { permissions: ["bookmarks"] }, true), true);
    assert.equal(await shared.safePermissionsContains(undefined, { permissions: ["bookmarks"] }, false), false);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("safePermissionsContains 正常 resolve 时返回真实结果", async () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    permissions: { contains: () => Promise.resolve(false), request: () => Promise.resolve(true), remove: () => Promise.resolve(true) }
  };
  try {
    assert.equal(await shared.safePermissionsContains(undefined, { permissions: ["bookmarks"] }, true), false);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("safePermissionsContains 调用挂起时超时返回 fallback（不死锁）", async () => {
  const previousChrome = globalThis.chrome;
  // contains 永不 resolve，模拟 Safari 挂起。
  globalThis.chrome = {
    permissions: { contains: () => new Promise(() => {}), request: () => Promise.resolve(true), remove: () => Promise.resolve(true) }
  };
  const started = Date.now();
  try {
    const result = await shared.safePermissionsContains(undefined, { permissions: ["bookmarks"] }, "TIMEOUT_FALLBACK");
    assert.equal(result, "TIMEOUT_FALLBACK");
    // 超时阈值 3000ms，但测试不应依赖精确时间，只确认最终返回了 fallback 且未永久挂起。
    assert.ok(Date.now() - started < 10_000);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("safePermissionsRequest 在权限 API 缺失时返回 fallback", async () => {
  const previousChrome = globalThis.chrome;
  delete globalThis.chrome;
  try {
    assert.equal(await shared.safePermissionsRequest(undefined, { permissions: ["bookmarks"] }, true), true);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("hasPermissionsApi 在无 chrome 或缺少 permissions 时返回 false", () => {
  // Node 全局没有 chrome，应返回 false。
  assert.equal(shared.hasPermissionsApi(), false);
  // canRequestPermissions 与 isPermissionsApiCallable 同样回落为 false。
  assert.equal(shared.canRequestPermissions(), false);
  assert.equal(shared.isPermissionsApiCallable(), false);
});

test("无 chrome.permissions 对象时运行时权限 API 视为不可调用", () => {
  const previousChrome = globalThis.chrome;
  // 模拟缺少 permissions 子对象的环境（Safari 14+ 其实支持，但缺失时不应崩溃）。
  globalThis.chrome = { engines: { webKit: {} } };
  try {
    assert.equal(shared.isSafari(), true);
    assert.equal(shared.hasPermissionsApi(), false);
    assert.equal(shared.canRequestPermissions(), false);
    assert.equal(shared.isPermissionsApiCallable(), false);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("Chromium 环境下运行时权限 API 可调用", () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    permissions: {
      contains: () => Promise.resolve(true),
      request: () => Promise.resolve(true),
      remove: () => Promise.resolve()
    }
  };
  try {
    assert.equal(shared.isSafari(), false);
    assert.equal(shared.hasPermissionsApi(), true);
    assert.equal(shared.canRequestPermissions(), true);
    assert.equal(shared.isPermissionsApiCallable(), true);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});
