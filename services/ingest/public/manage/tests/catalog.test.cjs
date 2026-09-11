const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "..", "catalog.js"), "utf8");

function field(value = "") {
  return { value, placeholder: "", textContent: "", focus() {}, select() {} };
}

function createHarness(apiRequest) {
  let opened = false;
  const elements = {
    settingsError: field(),
    settingsTitle: field(),
    settingsSubtitle: field(),
    settingsSearchEngine: field(),
    settingsLocalHosts: field(),
    aiTestResult: field(),
    aiApiKey: field(),
    agentName: field(),
    agentRolePrompt: field(),
    agentCapabilityPrompt: field(),
    aiProvider: field(),
    aiBaseUrl: field(),
    aiModel: field(),
    aiConfigStatus: {
      textContent: "",
      classList: { toggle() {} }
    },
    settingsDialog: { showModal() { opened = true; } }
  };
  const context = {
    state: {
      catalog: {
        settings: {
          title: "栖页",
          subtitle: "导航",
          defaultSearchEngine: "bing",
          localAccessHosts: ["nav.home.arpa"]
        }
      },
      aiConfig: null
    },
    elements,
    apiRequest,
    readableError: (error) => error.message
  };
  vm.runInNewContext(`${source}\nthis.openSettingsDialogForTest = openSettingsDialog;`, context);
  return { context, elements, isOpened: () => opened };
}

test("站点设置弹窗立即打开并回填导航助手配置", async () => {
  const config = {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    hasApiKey: true,
    configured: true,
    agentName: "我的助手",
    agentRolePrompt: "角色提示",
    agentCapabilityPrompt: "能力提示"
  };
  const harness = createHarness(async (path) => {
    assert.equal(path, "/ai/config");
    return config;
  });

  assert.doesNotThrow(() => harness.context.openSettingsDialogForTest());
  assert.equal(harness.isOpened(), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.elements.agentName.value, config.agentName);
  assert.equal(harness.elements.agentRolePrompt.value, config.agentRolePrompt);
  assert.equal(harness.elements.agentCapabilityPrompt.value, config.agentCapabilityPrompt);
  assert.equal(harness.elements.aiApiKey.value, "");
  assert.equal(harness.elements.aiApiKey.placeholder, "已安全保存，留空则保留");
});

test("AI 配置读取失败时保留已打开的设置弹窗并显示错误", async () => {
  const harness = createHarness(async () => {
    throw new Error("网络不可用");
  });

  assert.doesNotThrow(() => harness.context.openSettingsDialogForTest());
  assert.equal(harness.isOpened(), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.isOpened(), true);
  assert.equal(harness.elements.settingsError.textContent, "无法读取 AI 配置：网络不可用");
});
