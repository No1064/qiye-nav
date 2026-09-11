const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const shared = require("../shared.js");

const popupSource = readFileSync(join(__dirname, "..", "popup.js"), "utf8");

function createPopup(apiBaseUrl, createTab) {
  const elements = new Map();
  const listeners = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        addEventListener(type, handler) {
          listeners.set(`${selector}:${type}`, handler);
        },
        className: "",
        disabled: false,
        textContent: ""
      });
    }
    return elements.get(selector);
  };
  let closed = false;
  const context = {
    chrome: {
      runtime: { openOptionsPage() {} },
      tabs: { create: createTab }
    },
    document: {
      addEventListener(type, handler) {
        listeners.set(`document:${type}`, handler);
      },
      querySelector: element
    },
    NavShared: {
      ...shared,
      mergeSettings() {
        return shared.mergeSettings({ apiBaseUrl });
      }
    },
    URL,
    window: { close() { closed = true; } }
  };
  vm.runInNewContext(popupSource, context, { filename: "popup.js" });
  return {
    clickHome: listeners.get("#open-home:click"),
    elements,
    wasClosed: () => closed
  };
}

test("打开导航主页保留部署子路径并规范尾部斜杠", async () => {
  for (const [apiBaseUrl, expected] of [
    ["http://localhost:8787", "http://127.0.0.1:8787/"],
    ["https://nav.example.com/ingest/", "https://nav.example.com/ingest/"]
  ]) {
    let created;
    const popup = createPopup(apiBaseUrl, async (options) => { created = options; });
    await popup.clickHome();
    await new Promise(setImmediate);
    assert.equal(created.url, expected);
    assert.equal(popup.wasClosed(), true);
  }
});

test("打开导航主页失败时保留弹窗并显示错误", async () => {
  const popup = createPopup("https://nav.example.com", async () => {
    throw new Error("标签页不可用");
  });
  await popup.clickHome();
  await new Promise(setImmediate);
  const status = popup.elements.get("#status");
  assert.equal(popup.wasClosed(), false);
  assert.equal(popup.elements.get("#open-home").disabled, false);
  assert.match(status.textContent, /无法打开导航主页：标签页不可用/);
  assert.match(status.className, /error/);
});
