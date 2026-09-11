const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const extensionRoot = join(__dirname, "..");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

test("三态主题默认自动并实时跟随系统，手动主题保持固定", () => {
  let systemDark = false;
  let mediaListener = null;
  const storage = createStorage();
  const sandbox = {
    localStorage: storage,
    document: {
      documentElement: { dataset: {} },
      dispatchEvent() {}
    },
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    window: {
      matchMedia() {
        return {
          get matches() { return systemDark; },
          addEventListener(_type, listener) { mediaListener = listener; }
        };
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(join(extensionRoot, "newtab-theme.js"), "utf8"), sandbox);

  assert.equal(sandbox.QiyeTheme.getPreference(), "auto");
  assert.equal(sandbox.document.documentElement.dataset.theme, "light");
  systemDark = true;
  mediaListener();
  assert.equal(sandbox.document.documentElement.dataset.theme, "dark");

  sandbox.QiyeTheme.setPreference("light");
  systemDark = false;
  mediaListener();
  assert.equal(sandbox.QiyeTheme.getPreference(), "light");
  assert.equal(sandbox.document.documentElement.dataset.theme, "light");
});

test("Web 运行时使用同源 API、本地存储和管理页适配", async () => {
  const storage = createStorage();
  const opened = [];
  const sandbox = {
    localStorage: storage,
    location: { origin: "http://127.0.0.1:8080", replace() {} },
    navigator: {},
    window: { open(...args) { opened.push(args); }, location: { replace() {} } }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(join(extensionRoot, "newtab-runtime.js"), "utf8"), sandbox);

  assert.equal(sandbox.QiyeRuntime.isExtension, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.QiyeRuntime.defaultSettings)),
    { apiBaseUrl: "http://127.0.0.1:8080", newTabEnabled: true }
  );
  await sandbox.QiyeRuntime.storageSet("memo", "稍后处理");
  assert.equal(await sandbox.QiyeRuntime.storageGet("memo"), "稍后处理");
  await sandbox.QiyeRuntime.storageRemove("memo");
  assert.equal(await sandbox.QiyeRuntime.storageGet("memo"), null);
  await sandbox.QiyeRuntime.openSettings();
  assert.deepEqual(opened[0], ["/manage/", "_blank", "noopener,noreferrer"]);
});
