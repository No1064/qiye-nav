const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const NavShared = require("../shared.js");

function eventRecorder() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }
  };
}

test("service worker 可在 MV3 API 外形下加载并同步注册事件", () => {
  const events = {
    alarm: eventRecorder(),
    bookmarkCreated: eventRecorder(),
    command: eventRecorder(),
    contextClicked: eventRecorder(),
    installed: eventRecorder(),
    message: eventRecorder(),
    permissionAdded: eventRecorder(),
    permissionRemoved: eventRecorder(),
    startup: eventRecorder()
  };
  const storage = {};
  const chrome = {
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {}
    },
    alarms: {
      clear: async () => {},
      create: async () => {},
      onAlarm: events.alarm
    },
    bookmarks: { onCreated: events.bookmarkCreated },
    commands: { onCommand: events.command },
    contextMenus: {
      create: () => {},
      onClicked: events.contextClicked,
      removeAll: (callback) => callback()
    },
    permissions: {
      contains: async () => true,
      onAdded: events.permissionAdded,
      onRemoved: events.permissionRemoved
    },
    runtime: {
      onInstalled: events.installed,
      onMessage: events.message,
      onStartup: events.startup
    },
    storage: {
      local: {
        get: async (keys) => {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((key) => key in storage).map((key) => [key, storage[key]]));
        },
        set: async (values) => Object.assign(storage, values)
      }
    },
    tabs: { query: async () => [] }
  };
  const context = vm.createContext({
    AbortController,
    NavShared,
    chrome,
    clearTimeout,
    crypto: webcrypto,
    fetch: async () => new Response("{}", { status: 200 }),
    importScripts: () => {},
    self: { addEventListener: () => {} },
    setTimeout
  });

  const source = readFileSync(join(__dirname, "..", "background.js"), "utf8");
  assert.doesNotThrow(() => vm.runInContext(source, context, { filename: "background.js" }));

  for (const [name, event] of Object.entries(events)) {
    assert.ok(event.listeners.length > 0, `${name} 应在 worker 加载时注册监听器`);
  }
});
