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
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }
  };
}

function bookmarkTree(count) {
  return [{
    id: "0",
    children: [{
      id: "1",
      title: "书签栏",
      children: [{
        id: "folder",
        title: "工作",
        children: Array.from({ length: count }, (_, index) => ({
          id: `bookmark-${index}`,
          title: `书签 ${index}`,
          url: `https://example.com/${index}`
        }))
      }]
    }]
  }];
}

function createWorker(storage, fetchImpl, permissionGranted = true) {
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
  const chrome = {
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    alarms: { clear: async () => {}, create: async () => {}, onAlarm: events.alarm },
    bookmarks: { getTree: async () => bookmarkTree(201), onCreated: events.bookmarkCreated },
    commands: { onCommand: events.command },
    contextMenus: { create: () => {}, onClicked: events.contextClicked, removeAll: (callback) => callback() },
    permissions: {
      contains: async () => permissionGranted,
      onAdded: events.permissionAdded,
      onRemoved: events.permissionRemoved
    },
    runtime: { onInstalled: events.installed, onMessage: events.message, onStartup: events.startup },
    storage: {
      local: {
        get: async (keys) => {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((key) => key in storage).map((key) => [key, storage[key]]));
        },
        remove: async (key) => { delete storage[key]; },
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
    fetch: fetchImpl,
    importScripts: () => {},
    self: { addEventListener: () => {} },
    setTimeout
  });
  const source = readFileSync(join(__dirname, "..", "background.js"), "utf8");
  vm.runInContext(source, context, { filename: "background.js" });
  return { context, events };
}

test("未获 bookmarks 可选权限时不会扫描书签树", async () => {
  let treeReads = 0;
  const worker = createWorker({}, async () => new Response("{}", { status: 200 }), false);
  worker.context.chrome.bookmarks.getTree = async () => {
    treeReads += 1;
    return bookmarkTree(1);
  };
  await assert.rejects(
    vm.runInContext("previewBookmarkImport({selectedRootId: 'all'})", worker.context),
    /授权读取 Chrome 书签/
  );
  assert.equal(treeReads, 0);
});

test("取消任务会持久化终止状态并保留已完成批次", async () => {
  const plan = NavShared.buildBookmarkImportPlan(bookmarkTree(201), {
    selectedRootId: "all",
    defaultGroupId: "inbox"
  });
  const task = NavShared.createBookmarkImportTask(plan, {
    importSessionId: "cancel-session",
    defaultGroupId: "inbox",
    now: 10
  });
  task.status = "paused";
  task.batches[0].status = "completed";
  task.completedBatchIndexes = [0];
  task.summary.created = 200;
  const storage = { navBookmarkImportTask: task };
  const worker = createWorker(storage, async () => new Response("{}", { status: 200 }));

  const result = await vm.runInContext("cancelBookmarkImport()", worker.context);
  assert.equal(result.task.status, "cancelled");
  assert.equal(storage.navBookmarkImportTask.status, "cancelled");
  assert.deepEqual(Array.from(storage.navBookmarkImportTask.completedBatchIndexes), [0]);
});

test("批次进度持久化后可由新的 worker 使用同一幂等键续传", async () => {
  const storage = {
    navIngestSettings: {
      apiBaseUrl: "https://nav.example.com",
      token: "device-token",
      defaultGroupId: "inbox",
      autoSyncBookmarks: false
    },
    navIngestQueue: []
  };
  const firstWorkerRequests = [];
  const firstWorker = createWorker(storage, async (_url, init) => {
    const payload = JSON.parse(init.body);
    firstWorkerRequests.push({ key: init.headers["Idempotency-Key"], count: payload.items.length });
    if (firstWorkerRequests.length === 2) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({
      summary: { total: payload.items.length, created: payload.items.length, duplicate: 0, invalid: 0, failed: 0 },
      results: []
    }), { status: 200 });
  });

  const started = await vm.runInContext(
    "startBookmarkImport({selectedRootId: 'all', defaultGroupId: 'inbox'})",
    firstWorker.context
  );
  assert.equal(started.ok, true);
  await vm.runInContext("importPromise", firstWorker.context);

  const paused = JSON.parse(JSON.stringify(storage.navBookmarkImportTask));
  assert.equal(paused.status, "paused");
  assert.deepEqual(paused.completedBatchIndexes, [0]);
  assert.equal(paused.manifest.bookmarks.length, 201);
  assert.deepEqual(firstWorkerRequests.map((request) => request.count), [200, 1]);
  storage.navBookmarkImportTask.nextRetryAt = Date.now() - 1;

  const resumedRequests = [];
  const secondWorker = createWorker(storage, async (_url, init) => {
    const payload = JSON.parse(init.body);
    resumedRequests.push({ key: init.headers["Idempotency-Key"], count: payload.items.length });
    return new Response(JSON.stringify({
      summary: { total: payload.items.length, created: payload.items.length, duplicate: 0, invalid: 0, failed: 0 },
      results: []
    }), { status: 200 });
  });
  secondWorker.events.startup.listeners[0]();
  await vm.runInContext("importPromise", secondWorker.context);

  const completed = JSON.parse(JSON.stringify(storage.navBookmarkImportTask));
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.completedBatchIndexes, [0, 1]);
  assert.equal(completed.summary.created, 201);
  assert.deepEqual(resumedRequests, [{ key: firstWorkerRequests[1].key, count: 1 }]);
});
