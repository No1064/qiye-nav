importScripts("shared.js");

const {
  buildBookmarkImportBatchPayload,
  buildBookmarkImportPlan,
  calculateBackoffMs,
  canonicalizeUrl,
  createBookmarkImportTask,
  endpoint,
  extractGroups,
  isPermissionsApiCallable,
  hasPermissionsApi,
  isSavableUrl,
  listBookmarkSubtrees,
  mergeSettings,
  normalizeGroupId,
  responseError,
  shouldUseHostPermissions,
  safePermissionsContains,
  safePermissionsRequest,
  safePermissionsRemove,
  summarizeImportResponse
} = NavShared;

const SETTINGS_KEY = "navIngestSettings";
const QUEUE_KEY = "navIngestQueue";
const IMPORT_TASK_KEY = "navBookmarkImportTask";
const RETRY_ALARM = "nav-ingest-retry";
const IMPORT_RETRY_ALARM = "nav-bookmark-import-retry";
const MENU_PAGE = "save-page-to-nav";
const MENU_LINK = "save-link-to-nav";
const MAX_QUEUE_SIZE = 200;
const REQUEST_TIMEOUT_MS = 12_000;

let queueOperation = Promise.resolve();
let flushPromise = null;
let importPromise = null;
let importAbortController = null;
let importCancellationRequested = false;
let badgeTimer = null;

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
  void initializeStorage();
  void flushQueue({ force: false });
  void resumeBookmarkImport({ force: false });
});

chrome.runtime.onStartup.addListener(() => {
  void flushQueue({ force: false });
  void resumeBookmarkImport({ force: false });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_PAGE && info.menuItemId !== MENU_LINK) return;
  const url = info.menuItemId === MENU_LINK ? info.linkUrl : info.pageUrl || tab?.url;
  const title = info.menuItemId === MENU_LINK
    ? info.selectionText || info.linkUrl
    : tab?.title || info.pageUrl;

  void saveAndSignal({
    url,
    title,
    trigger: info.menuItemId === MENU_LINK ? "context_menu_link" : "context_menu_page"
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "save-current-tab") return;
  void saveActiveTab("keyboard_shortcut");
});

// 可选权限可能在 worker 启动后才获批，因此既在顶层尝试，也监听权限变化补注册。
let bookmarkListenerRegistered = false;
registerBookmarkListener();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) {
    void flushQueue({ force: false });
  }
  if (alarm.name === IMPORT_RETRY_ALARM) {
    void resumeBookmarkImport({ force: false });
  }
});

// 部分环境（如扩展运行时缺少 permissions API）不应在加载时直接注册事件，
// 否则后台 worker 抛错导致整个扩展失效。做防御性判断。
if (hasPermissionsApi(chrome)) {
  chrome.permissions.onAdded.addListener((permissions) => {
    if (permissions.permissions?.includes("bookmarks")) registerBookmarkListener();
    if (permissions.origins?.length || permissions.permissions?.includes("bookmarks")) {
      void flushQueue({ force: true });
    }
    if (permissions.origins?.length) void resumeBookmarkImport({ force: true });
  });

  chrome.permissions.onRemoved.addListener((permissions) => {
    if (permissions.permissions?.includes("bookmarks")) unregisterBookmarkListener();
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
  return true;
});

self.addEventListener?.("online", () => {
  void flushQueue({ force: true });
  void resumeBookmarkImport({ force: true });
});

async function handleMessage(message) {
  switch (message?.type) {
    case "SAVE_BOOKMARK":
      return saveBookmark(message.bookmark);
    case "GET_GROUPS":
      return getGroups();
    case "GET_QUEUE_STATUS":
      return getQueueStatus();
    case "RETRY_QUEUE":
      return flushQueue({ force: true });
    case "CLEAR_QUEUE":
      await setQueue([]);
      await updateQueueBadge();
      return { ok: true, count: 0 };
    case "SETTINGS_UPDATED":
      await flushQueue({ force: true });
      return { ok: true };
    case "TEST_CONNECTION":
      return testConnection();
    case "PREVIEW_BOOKMARK_IMPORT":
      return previewBookmarkImport(message);
    case "START_BOOKMARK_IMPORT":
      return startBookmarkImport(message);
    case "GET_BOOKMARK_IMPORT_STATUS":
      return getBookmarkImportStatus();
    case "RESUME_BOOKMARK_IMPORT":
      void resumeBookmarkImport({ force: true });
      return getBookmarkImportStatus();
    case "CANCEL_BOOKMARK_IMPORT":
      return cancelBookmarkImport();
    case "CLEAR_BOOKMARK_IMPORT":
      return clearBookmarkImport();
    default:
      return { ok: false, error: "未知操作" };
  }
}

async function initializeStorage() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, QUEUE_KEY, IMPORT_TASK_KEY]);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: mergeSettings() });
  }
  if (!Array.isArray(stored[QUEUE_KEY])) {
    await chrome.storage.local.set({ [QUEUE_KEY]: [] });
  }
  await updateQueueBadge();
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: "保存此页面到栖页",
      contexts: ["page"]
    });
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: "保存此链接到栖页",
      contexts: ["link"]
    });
  });
}

async function saveActiveTab(trigger) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return saveAndSignal({ url: tab?.url, title: tab?.title, trigger });
}

async function saveAndSignal(bookmark) {
  const result = await saveBookmark(bookmark);
  if (result.ok && result.status === "saved") {
    showTransientBadge("✓", "#087a5b");
  } else if (result.ok && result.status === "queued") {
    await updateQueueBadge();
  } else {
    showTransientBadge("!", "#b44536");
  }
  return result;
}

async function handleBookmarkCreated(bookmarkId, node) {
  if (!node?.url) return;
  const settings = await getSettings();
  if (!settings.autoSyncBookmarks) return;

  // 缺少 permissions API 时按已授权放行，避免拦截保存。
  const hasPermission = isPermissionsApiCallable(chrome)
    ? await safePermissionsContains(chrome, { permissions: ["bookmarks"] }, true)
    : true;
  if (!hasPermission) return;

  await saveAndSignal({
    url: node.url,
    title: node.title || node.url,
    groupId: settings.defaultGroupId,
    trigger: "chrome_bookmark_created",
    chromeBookmarkId: bookmarkId
  });
}

function registerBookmarkListener() {
  if (bookmarkListenerRegistered || !chrome.bookmarks?.onCreated) return;
  chrome.bookmarks.onCreated.addListener(bookmarkCreatedListener);
  bookmarkListenerRegistered = true;
}

function unregisterBookmarkListener() {
  if (!bookmarkListenerRegistered) return;
  chrome.bookmarks?.onCreated?.removeListener(bookmarkCreatedListener);
  bookmarkListenerRegistered = false;
}

function bookmarkCreatedListener(bookmarkId, node) {
  void handleBookmarkCreated(bookmarkId, node);
}

async function saveBookmark(input) {
  if (!isSavableUrl(input?.url)) {
    return { ok: false, error: "当前页面不是可保存的 HTTP(S) 网页" };
  }

  const settings = await getSettings();
  if (!settings.apiBaseUrl) {
    return { ok: false, error: "请先配置 Nav Ingest API" };
  }
  // 缺少 permissions API 或 Safari（host 权限不豁免 CORS、且 origins 权限会挂起）时按已授权放行，避免拦截保存。
  const hasApiPermission = shouldUseHostPermissions(chrome)
    ? (await safePermissionsContains(chrome, { origins: [NavShared.buildPermissionOrigin(settings.apiBaseUrl)] }, true))
    : true;
  if (!hasApiPermission) {
    return { ok: false, error: "请先在扩展设置中授权 API 地址" };
  }

  const payload = {
    url: canonicalizeUrl(input.url),
    title: String(input.title || input.url).trim().slice(0, 500),
    groupId: normalizeGroupId(input.groupId || settings.defaultGroupId),
    source: "chrome_extension",
    trigger: input.trigger || "toolbar",
    ...(input.chromeBookmarkId
      ? { chromeBookmarkId: String(input.chromeBookmarkId) }
      : {})
  };
  const idempotencyKey = input.chromeBookmarkId
    ? `chrome-bookmark-${String(input.chromeBookmarkId).replace(/[^a-zA-Z0-9._-]/g, "-")}`
    : `nav-${crypto.randomUUID()}`;

  try {
    const response = await postBookmark(settings, payload, idempotencyKey);
    return { ok: true, status: "saved", response };
  } catch (error) {
    if (!error.retryable) {
      return { ok: false, error: readableError(error) };
    }

    const queued = await enqueue({ payload, idempotencyKey, lastError: readableError(error) });
    if (!queued.ok) return queued;
    return { ok: true, status: "queued", queueCount: queued.count };
  }
}

async function postBookmark(settings, payload, idempotencyKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint(settings.apiBaseUrl, "/api/v1/bookmarks"), {
      method: "POST",
      headers: requestHeaders(settings.token, idempotencyKey),
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const body = await parseResponse(response);

    if (response.ok || response.status === 409) {
      return body;
    }

    const error = new Error(responseError(body, `服务返回 ${response.status}`));
    error.code = body?.error?.code;
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw error;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("连接超时，已加入待同步队列");
      timeoutError.retryable = true;
      throw timeoutError;
    }
    if (typeof error.retryable !== "boolean") error.retryable = true;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getGroups() {
  const settings = await getSettings();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint(settings.apiBaseUrl, "/api/v1/groups"), {
      headers: requestHeaders(settings.token),
      signal: controller.signal
    });
    const body = await parseResponse(response);
    if (!response.ok) throw new Error(responseError(body, `服务返回 ${response.status}`));
    return { ok: true, groups: extractGroups(body) };
  } catch (error) {
    return {
      ok: false,
      error: readableError(error),
      groups: [{ id: settings.defaultGroupId, name: settings.defaultGroupId }]
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function testConnection() {
  const result = await getGroups();
  return result.ok
    ? { ok: true, groupCount: result.groups.length }
    : result;
}

function requestHeaders(token, idempotencyKey) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
  };
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

async function enqueue({ payload, idempotencyKey, lastError }) {
  return withQueueLock(async () => {
    const queue = await getQueue();
    if (queue.length >= MAX_QUEUE_SIZE) {
      return { ok: false, error: "待同步队列已满，请先恢复连接并重试" };
    }

    queue.push({
      id: crypto.randomUUID(),
      payload,
      idempotencyKey,
      attempts: 0,
      createdAt: Date.now(),
      nextAttemptAt: Date.now() + calculateBackoffMs(0),
      lastError
    });
    await chrome.storage.local.set({ [QUEUE_KEY]: queue });
    await scheduleNextRetry(queue);
    await updateQueueBadge(queue.length);
    return { ok: true, count: queue.length };
  });
}

function flushQueue({ force }) {
  if (flushPromise) return flushPromise;
  flushPromise = performFlush(Boolean(force)).finally(() => {
    flushPromise = null;
  });
  return flushPromise;
}

async function performFlush(force) {
  return withQueueLock(async () => {
    const settings = await getSettings();
    const queue = await getQueue();
    if (!queue.length) {
      await chrome.alarms.clear(RETRY_ALARM);
      await updateQueueBadge(0);
      return { ok: true, count: 0, synced: 0 };
    }

    const now = Date.now();
    const remaining = [];
    let synced = 0;

    for (const item of queue) {
      if (!force && item.nextAttemptAt > now) {
        remaining.push(item);
        continue;
      }

      try {
        await postBookmark(settings, item.payload, item.idempotencyKey);
        synced += 1;
      } catch (error) {
        const attempts = item.attempts + 1;
        remaining.push({
          ...item,
          attempts,
          lastError: readableError(error),
          nextAttemptAt: Date.now() + calculateBackoffMs(attempts)
        });
      }
    }

    await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
    await scheduleNextRetry(remaining);
    await updateQueueBadge(remaining.length);
    return { ok: true, count: remaining.length, synced };
  });
}

async function getQueueStatus() {
  const queue = await getQueue();
  return {
    ok: true,
    count: queue.length,
    oldestAt: queue.length ? Math.min(...queue.map((item) => item.createdAt)) : null,
    lastError: queue.at(-1)?.lastError || ""
  };
}

async function getQueue() {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  return Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
}

async function setQueue(queue) {
  await withQueueLock(async () => {
    await chrome.storage.local.set({ [QUEUE_KEY]: queue });
    await scheduleNextRetry(queue);
  });
}

async function scheduleNextRetry(queue) {
  if (!queue.length) {
    await chrome.alarms.clear(RETRY_ALARM);
    return;
  }
  const when = Math.max(Date.now() + 1_000, Math.min(...queue.map((item) => item.nextAttemptAt)));
  await chrome.alarms.create(RETRY_ALARM, { when });
}

function withQueueLock(operation) {
  const run = queueOperation.then(operation, operation);
  queueOperation = run.catch(() => {});
  return run;
}

async function previewBookmarkImport(message) {
  await assertBookmarkPermission();
  const tree = await chrome.bookmarks.getTree();
  const plan = buildBookmarkImportPlan(tree, {
    selectedRootId: message?.selectedRootId,
    defaultGroupId: message?.defaultGroupId
  });
  return {
    ok: true,
    preview: plan.preview,
    details: plan.details,
    groups: plan.groups.map(({ sourceKey, name, path }) => ({ sourceKey, name, path })),
    sourceOptions: listBookmarkSubtrees(tree)
  };
}

async function startBookmarkImport(message) {
  await assertBookmarkPermission();
  const settings = await getSettings();
  await assertApiPermission(settings);
  const existing = await getBookmarkImportTask();
  if (existing && !["completed", "cancelled"].includes(existing.status)) {
    return { ok: false, error: "已有导入任务，请先继续或取消当前任务" };
  }

  const tree = await chrome.bookmarks.getTree();
  const sourceOptions = listBookmarkSubtrees(tree);
  const selectedRootId = String(message?.selectedRootId || "all");
  const sourceLabel = sourceOptions.find((item) => item.id === selectedRootId)?.label;
  if (!sourceLabel) return { ok: false, error: "所选书签文件夹已不存在，请重新读取" };

  const plan = buildBookmarkImportPlan(tree, {
    selectedRootId,
    defaultGroupId: message?.defaultGroupId || settings.defaultGroupId
  });
  const task = createBookmarkImportTask(plan, {
    importSessionId: crypto.randomUUID(),
    sourceLabel,
    defaultGroupId: message?.defaultGroupId || settings.defaultGroupId
  });
  importCancellationRequested = false;
  await setBookmarkImportTask(task);
  await scheduleImportRetry(Date.now() + 60_000);
  void resumeBookmarkImport({ force: true });
  return { ok: true, task: publicImportTask(task) };
}

async function assertBookmarkPermission() {
  // 缺少 permissions API 时回退为仅检查 bookmarks API 是否可用。
  const granted = isPermissionsApiCallable(chrome)
    ? await safePermissionsContains(chrome, { permissions: ["bookmarks"] }, Boolean(chrome.bookmarks?.getTree))
    : Boolean(chrome.bookmarks?.getTree);
  if (!granted || !chrome.bookmarks?.getTree) {
    throw new Error("请先点击授权读取 Chrome 书签");
  }
}

async function assertApiPermission(settings) {
  // 缺少 permissions API 或 Safari（host 权限不豁免 CORS）时直接放行，避免拦截请求。
  if (!shouldUseHostPermissions(chrome)) return;
  const granted = await safePermissionsContains(chrome, {
    origins: [NavShared.buildPermissionOrigin(settings.apiBaseUrl)]
  }, true);
  if (!granted) throw new Error("请先保存设置并授权 Nav Ingest API 地址");
}

function resumeBookmarkImport({ force }) {
  if (importPromise) return importPromise;
  importPromise = performBookmarkImport(Boolean(force)).finally(() => {
    importPromise = null;
  });
  return importPromise;
}

async function performBookmarkImport(force) {
  let task = await getBookmarkImportTask();
  if (!task || ["completed", "cancelled"].includes(task.status)) {
    await chrome.alarms.clear(IMPORT_RETRY_ALARM);
    return { ok: true, task: publicImportTask(task) };
  }
  if (!force && task.nextRetryAt && task.nextRetryAt > Date.now()) {
    await scheduleImportRetry(task.nextRetryAt);
    return { ok: true, task: publicImportTask(task) };
  }

  const settings = await getSettings();
  try {
    await assertApiPermission(settings);
  } catch (error) {
    task.status = "paused";
    task.lastError = readableError(error);
    task.nextRetryAt = null;
    task.updatedAt = Date.now();
    await setBookmarkImportTask(task);
    return { ok: false, error: task.lastError, task: publicImportTask(task) };
  }

  importCancellationRequested = false;
  task.status = "running";
  task.lastError = "";
  task.nextRetryAt = null;
  task.updatedAt = Date.now();
  await setBookmarkImportTask(task);

  for (const batch of task.batches) {
    if (batch.status === "completed") continue;
    const latest = await getBookmarkImportTask();
    if (!latest || latest.status === "cancelled" || importCancellationRequested) {
      return { ok: true, task: publicImportTask(latest) };
    }
    task = latest;
    const currentBatch = task.batches[batch.index];
    currentBatch.status = "sending";
    currentBatch.attempts += 1;
    currentBatch.lastError = "";
    task.updatedAt = Date.now();
    await setBookmarkImportTask(task);
    await scheduleImportRetry(Date.now() + 60_000);

    try {
      const body = await postBookmarkImportBatch(
        settings,
        buildBookmarkImportBatchPayload(task, currentBatch.index),
        currentBatch.idempotencyKey
      );
      const afterRequest = await getBookmarkImportTask();
      if (!afterRequest || afterRequest.status === "cancelled" || importCancellationRequested) {
        return { ok: true, task: publicImportTask(afterRequest) };
      }
      task = afterRequest;
      const completedBatch = task.batches[currentBatch.index];
      const expectedTotal = completedBatch.end - completedBatch.start;
      const summary = summarizeImportResponse(body, expectedTotal);
      completedBatch.status = "completed";
      completedBatch.lastError = "";
      completedBatch.result = {
        summary,
        results: Array.isArray(body?.results) ? body.results : []
      };
      if (!task.completedBatchIndexes.includes(currentBatch.index)) {
        task.completedBatchIndexes.push(currentBatch.index);
        for (const key of ["created", "duplicate", "invalid", "failed"]) {
          task.summary[key] += summary[key];
        }
      }
      task.updatedAt = Date.now();
      await setBookmarkImportTask(task);
    } catch (error) {
      const failedTask = await getBookmarkImportTask();
      if (!failedTask || failedTask.status === "cancelled" || importCancellationRequested) {
        return { ok: true, task: publicImportTask(failedTask) };
      }
      const failedBatch = failedTask.batches[currentBatch.index];
      const delay = calculateBackoffMs(failedBatch.attempts);
      failedBatch.status = "pending";
      failedBatch.lastError = readableError(error);
      failedTask.status = "paused";
      failedTask.lastError = failedBatch.lastError;
      failedTask.nextRetryAt = error.retryable ? Date.now() + delay : null;
      failedTask.updatedAt = Date.now();
      await setBookmarkImportTask(failedTask);
      if (failedTask.nextRetryAt) await scheduleImportRetry(failedTask.nextRetryAt);
      else await chrome.alarms.clear(IMPORT_RETRY_ALARM);
      return { ok: false, error: failedTask.lastError, task: publicImportTask(failedTask) };
    }
  }

  task = await getBookmarkImportTask();
  if (task && task.status !== "cancelled") {
    task.status = "completed";
    task.completedAt = Date.now();
    task.updatedAt = task.completedAt;
    task.nextRetryAt = null;
    task.lastError = "";
    await setBookmarkImportTask(task);
  }
  await chrome.alarms.clear(IMPORT_RETRY_ALARM);
  return { ok: true, task: publicImportTask(task) };
}

async function postBookmarkImportBatch(settings, payload, idempotencyKey) {
  importAbortController = new AbortController();
  const timeout = setTimeout(() => importAbortController?.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint(settings.apiBaseUrl, "/api/v1/bookmarks/batch"), {
      method: "POST",
      headers: requestHeaders(settings.token, idempotencyKey),
      body: JSON.stringify(payload),
      signal: importAbortController.signal
    });
    const body = await parseResponse(response);
    if (response.ok) return body;
    const error = new Error(responseError(body, `服务返回 ${response.status}`));
    error.code = body?.error?.code;
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw error;
  } catch (error) {
    if (error.name === "AbortError") {
      const aborted = new Error(importCancellationRequested ? "导入已取消" : "连接超时，稍后会从当前批次继续");
      aborted.retryable = !importCancellationRequested;
      throw aborted;
    }
    if (typeof error.retryable !== "boolean") error.retryable = true;
    throw error;
  } finally {
    clearTimeout(timeout);
    importAbortController = null;
  }
}

async function cancelBookmarkImport() {
  importCancellationRequested = true;
  importAbortController?.abort();
  const task = await getBookmarkImportTask();
  if (!task) return { ok: true, task: null };
  if (task.status !== "completed") {
    task.status = "cancelled";
    task.cancelledAt = Date.now();
    task.updatedAt = task.cancelledAt;
    task.nextRetryAt = null;
    task.lastError = "";
    const sendingBatch = task.batches.find((batch) => batch.status === "sending");
    if (sendingBatch) sendingBatch.status = "pending";
    await setBookmarkImportTask(task);
  }
  await chrome.alarms.clear(IMPORT_RETRY_ALARM);
  return { ok: true, task: publicImportTask(task) };
}

async function clearBookmarkImport() {
  const task = await getBookmarkImportTask();
  if (task && !["completed", "cancelled"].includes(task.status)) {
    return { ok: false, error: "请先取消正在进行的导入任务" };
  }
  await chrome.storage.local.remove(IMPORT_TASK_KEY);
  return { ok: true, task: null };
}

async function getBookmarkImportStatus() {
  return { ok: true, task: publicImportTask(await getBookmarkImportTask()) };
}

async function getBookmarkImportTask() {
  const stored = await chrome.storage.local.get(IMPORT_TASK_KEY);
  return stored[IMPORT_TASK_KEY] || null;
}

async function setBookmarkImportTask(task) {
  await chrome.storage.local.set({ [IMPORT_TASK_KEY]: task });
}

async function scheduleImportRetry(when) {
  await chrome.alarms.create(IMPORT_RETRY_ALARM, { when: Math.max(Date.now() + 1_000, when) });
}

function publicImportTask(task) {
  if (!task) return null;
  return {
    importSessionId: task.importSessionId,
    status: task.status,
    sourceLabel: task.sourceLabel,
    defaultGroupId: task.defaultGroupId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt || null,
    cancelledAt: task.cancelledAt || null,
    nextRetryAt: task.nextRetryAt || null,
    lastError: task.lastError || "",
    preview: task.preview,
    summary: task.summary,
    completedBatches: task.completedBatchIndexes.length,
    totalBatches: task.batches.length
  };
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY]);
}

async function updateQueueBadge(count) {
  const actualCount = typeof count === "number" ? count : (await getQueue()).length;
  if (!actualCount) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#9a6a20" });
  await chrome.action.setBadgeText({ text: actualCount > 99 ? "99+" : String(actualCount) });
}

function showTransientBadge(text, color) {
  if (badgeTimer) clearTimeout(badgeTimer);
  void chrome.action.setBadgeBackgroundColor({ color });
  void chrome.action.setBadgeText({ text });
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    void updateQueueBadge();
  }, 1800);
}

function readableError(error) {
  if (!error) return "未知错误";
  if (error.message === "Failed to fetch") return "无法连接 API";
  return String(error.message || error).slice(0, 300);
}
