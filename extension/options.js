"use strict";

const SETTINGS_KEY = "navIngestSettings";
const IMPORT_TASK_KEY = "navBookmarkImportTask";
const elements = {
  apiBaseUrl: document.querySelector("#api-base-url"),
  apiError: document.querySelector("#api-error"),
  apiPermission: document.querySelector("#api-permission"),
  autoSync: document.querySelector("#auto-sync"),
  bookmarkPermission: document.querySelector("#bookmark-permission"),
  clearQueue: document.querySelector("#clear-queue"),
  connectionResult: document.querySelector("#connection-result"),
  closeImportDetail: document.querySelector("#close-import-detail"),
  defaultGroup: document.querySelector("#default-group"),
  form: document.querySelector("#settings-form"),
  importBatchCount: document.querySelector("#import-batch-count"),
  importBookmarkCount: document.querySelector("#import-bookmark-count"),
  importConfirm: document.querySelector("#import-confirm"),
  importCreatedCount: document.querySelector("#import-created-count"),
  importDefaultGroup: document.querySelector("#import-default-group"),
  importDetailEyebrow: document.querySelector("#import-detail-eyebrow"),
  importDetailList: document.querySelector("#import-detail-list"),
  importDetailPanel: document.querySelector("#import-detail-panel"),
  importDetailTitle: document.querySelector("#import-detail-title"),
  importDuplicateCount: document.querySelector("#import-duplicate-count"),
  importEmpty: document.querySelector("#import-empty"),
  importFailedCount: document.querySelector("#import-failed-count"),
  importGroupChips: document.querySelector("#import-group-chips"),
  importGroupCount: document.querySelector("#import-group-count"),
  importInvalidCount: document.querySelector("#import-invalid-count"),
  importLooseCount: document.querySelector("#import-loose-count"),
  importLooseDetailToggle: document.querySelector("#import-loose-detail-toggle"),
  importPreview: document.querySelector("#import-preview"),
  importProgressBar: document.querySelector("#import-progress-bar"),
  importProgressLabel: document.querySelector("#import-progress-label"),
  importProgressTrack: document.querySelector(".progress-track"),
  importResult: document.querySelector("#import-result"),
  importSkipCount: document.querySelector("#import-skip-count"),
  importSkipDetailToggle: document.querySelector("#import-skip-detail-toggle"),
  importSource: document.querySelector("#import-source"),
  importStateBadge: document.querySelector("#import-state-badge"),
  importTask: document.querySelector("#import-task"),
  importTaskError: document.querySelector("#import-task-error"),
  importTaskEyebrow: document.querySelector("#import-task-eyebrow"),
  importTaskNote: document.querySelector("#import-task-note"),
  importTaskTitle: document.querySelector("#import-task-title"),
  importTotalCount: document.querySelector("#import-total-count"),
  newBookmarkImport: document.querySelector("#new-bookmark-import"),
  newTabEnabled: document.querySelector("#new-tab-enabled"),
  newTabPermission: document.querySelector("#newtab-permission"),
  loadMoreImportDetail: document.querySelector("#load-more-import-detail"),
  queueCount: document.querySelector("#queue-count"),
  queueState: document.querySelector("#queue-state"),
  retryQueue: document.querySelector("#retry-queue"),
  readBookmarks: document.querySelector("#read-bookmarks"),
  refreshImportPreview: document.querySelector("#refresh-import-preview"),
  resumeBookmarkImport: document.querySelector("#resume-bookmark-import"),
  saveIndicator: document.querySelector("#save-indicator"),
  startBookmarkImport: document.querySelector("#start-bookmark-import"),
  testConnection: document.querySelector("#test-connection"),
  token: document.querySelector("#token"),
  toggleToken: document.querySelector("#toggle-token"),
  cancelBookmarkImport: document.querySelector("#cancel-bookmark-import")
};

let originalSettings = NavShared.mergeSettings();
let currentImportPreview = null;
let availableGroups = [];
let activeImportDetail = null;
let visibleImportDetailCount = 50;

document.addEventListener("DOMContentLoaded", initialize);
elements.form.addEventListener("submit", handleSubmit);
elements.testConnection.addEventListener("click", handleTestConnection);
elements.retryQueue.addEventListener("click", retryQueue);
elements.clearQueue.addEventListener("click", clearQueue);
elements.toggleToken.addEventListener("click", toggleTokenVisibility);
elements.form.addEventListener("input", markDirty);
elements.readBookmarks.addEventListener("click", readBookmarksForImport);
elements.refreshImportPreview.addEventListener("click", refreshBookmarkPreview);
elements.importSource.addEventListener("change", refreshBookmarkPreview);
elements.importDefaultGroup.addEventListener("change", refreshBookmarkPreview);
elements.importConfirm.addEventListener("change", updateImportStartState);
elements.newTabEnabled.addEventListener("change", renderNewTabBadge);
elements.importLooseDetailToggle.addEventListener("click", () => toggleImportDetail("loose"));
elements.importSkipDetailToggle.addEventListener("click", () => toggleImportDetail("skipped"));
elements.closeImportDetail.addEventListener("click", closeImportDetail);
elements.loadMoreImportDetail.addEventListener("click", loadMoreImportDetail);
elements.startBookmarkImport.addEventListener("click", startBookmarkImport);
elements.resumeBookmarkImport.addEventListener("click", resumeBookmarkImport);
elements.cancelBookmarkImport.addEventListener("click", cancelBookmarkImport);
elements.newBookmarkImport.addEventListener("click", resetBookmarkImport);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[IMPORT_TASK_KEY]) void renderBookmarkImportStatus();
});

async function initialize() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  originalSettings = NavShared.mergeSettings(stored[SETTINGS_KEY]);
  elements.apiBaseUrl.value = originalSettings.apiBaseUrl;
  elements.token.value = originalSettings.token;
  renderGroupSelects(originalSettings.defaultGroupId, originalSettings.defaultGroupId, "连接后显示分组名称", true);
  elements.autoSync.checked = originalSettings.autoSyncBookmarks;
  elements.newTabEnabled.checked = originalSettings.newTabEnabled;
  renderNewTabBadge();
  await Promise.all([renderPermissions(), renderQueue(), renderBookmarkImportStatus()]);
  if (await hasApiPermission(originalSettings.apiBaseUrl)) await loadGroups();
}

async function handleSubmit(event) {
  event.preventDefault();
  const saved = await saveOptions();
  if (saved) {
    showResult("设置已保存，扩展现在可以连接 Nav Ingest。", "success");
    await loadGroups();
  }
}

async function saveOptions() {
  clearFieldError();
  let apiBaseUrl;
  try {
    apiBaseUrl = NavShared.normalizeApiBaseUrl(elements.apiBaseUrl.value);
  } catch (error) {
    showFieldError(error.message);
    return false;
  }

  const newOrigin = NavShared.buildPermissionOrigin(apiBaseUrl);
  const oldOrigin = NavShared.buildPermissionOrigin(originalSettings.apiBaseUrl);
  // Safari/WebKit 对扩展后台 fetch 强制 CORS、host 权限不豁免，且 origins 权限申请会挂起，
  // 因此 Safari 下跳过 origins 权限申请（服务端 CORS 已放行），仅在开启自动同步时仍请求 bookmarks。
  const needsHostPermission = NavShared.shouldUseHostPermissions();
  const requestedPermissions = {
    ...(needsHostPermission ? { origins: [newOrigin] } : {}),
    ...(elements.autoSync.checked ? { permissions: ["bookmarks"] } : {})
  };

  // 缺少 chrome.permissions 运行时 API，或没有需要请求的权限时，直接保存。
  const hasAnythingToRequest = needsHostPermission || elements.autoSync.checked;
  if (NavShared.canRequestPermissions() && hasAnythingToRequest) {
    const permissionsGranted = await NavShared.safePermissionsRequest(undefined, requestedPermissions, true);
    if (!permissionsGranted) {
      showResult(
        elements.autoSync.checked
          ? "未授予 API 或书签权限，设置没有保存。你可以关闭自动同步后只授权 API。"
          : "未授予 API 地址访问权限，设置没有保存。",
        "error"
      );
      return false;
    }

    if (!elements.autoSync.checked) {
      await NavShared.safePermissionsRemove(undefined, { permissions: ["bookmarks"] });
    }
  }

  const nextSettings = NavShared.mergeSettings({
    apiBaseUrl,
    token: elements.token.value.trim(),
    defaultGroupId: elements.defaultGroup.value || originalSettings.defaultGroupId,
    autoSyncBookmarks: elements.autoSync.checked,
    newTabEnabled: elements.newTabEnabled.checked
  });
  await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });

  if (oldOrigin !== newOrigin && NavShared.shouldUseHostPermissions()) {
    await NavShared.safePermissionsRemove(undefined, { origins: [oldOrigin] });
  }

  originalSettings = nextSettings;
  elements.apiBaseUrl.value = nextSettings.apiBaseUrl;
  elements.defaultGroup.value = nextSettings.defaultGroupId;
  elements.saveIndicator.textContent = "已保存";
  elements.saveIndicator.classList.add("saved");
  await chrome.runtime.sendMessage({ type: "SETTINGS_UPDATED" });
  await Promise.all([renderPermissions(), renderQueue()]);
  return true;
}

async function handleTestConnection() {
  setButtonBusy(elements.testConnection, true, "测试中…");
  const saved = await saveOptions();
  if (!saved) {
    setButtonBusy(elements.testConnection, false, "测试连接");
    return;
  }

  const result = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
  setButtonBusy(elements.testConnection, false, "测试连接");
  if (result?.ok) {
    showResult(`连接成功，读取到 ${result.groupCount} 个分组。`, "success");
    await loadGroups();
  } else {
    showResult(result?.error || "连接失败，请检查地址与令牌。", "error");
  }
}

async function loadGroups() {
  const desiredDefault = elements.defaultGroup.value || originalSettings.defaultGroupId;
  const desiredImport = elements.importDefaultGroup.value || desiredDefault;
  renderGroupSelects(desiredDefault, desiredImport, "正在读取分组…", true);
  const result = await chrome.runtime.sendMessage({ type: "GET_GROUPS" });
  if (!result?.ok) {
    availableGroups = [];
    renderGroupSelects(desiredDefault, desiredImport, "连接失败，测试连接后重试", true);
    return false;
  }
  availableGroups = Array.isArray(result.groups) ? result.groups : [];
  renderGroupSelects(desiredDefault, desiredImport);
  return true;
}

function renderGroupSelects(defaultId, importId, placeholder, disabled = false) {
  renderGroupSelect(elements.defaultGroup, defaultId, placeholder, disabled);
  renderGroupSelect(elements.importDefaultGroup, importId, placeholder, disabled);
  updateImportStartState();
}

function renderGroupSelect(select, selectedId, placeholder, disabled) {
  select.replaceChildren();
  if (disabled || !availableGroups.length) {
    const option = document.createElement("option");
    option.value = selectedId || "";
    option.textContent = placeholder || "当前导航站还没有分组";
    select.append(option);
    select.disabled = true;
    return;
  }

  const known = availableGroups.some((group) => group.id === selectedId);
  if (!known) {
    const missing = document.createElement("option");
    missing.value = "";
    missing.textContent = selectedId ? "原分组已不可用，请重新选择" : "请选择分组";
    missing.disabled = true;
    missing.selected = true;
    select.append(missing);
  }
  for (const group of availableGroups) {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = group.name;
    option.selected = group.id === selectedId;
    select.append(option);
  }
  select.disabled = false;
}

async function readBookmarksForImport() {
  setButtonBusy(elements.readBookmarks, true, "正在读取…");
  hideImportResult();
  // 缺少 chrome.permissions.request 时直接读取（书签权限走声明式模型）。
  const granted = NavShared.canRequestPermissions()
    ? await NavShared.safePermissionsRequest(undefined, { permissions: ["bookmarks"] }, Boolean(chrome.bookmarks?.getTree))
    : Boolean(chrome.bookmarks?.getTree);
  if (!granted) {
    setButtonBusy(elements.readBookmarks, false, "授权并读取");
    showImportResult("未授予书签权限。扩展不会读取或上传任何书签。", true);
    return;
  }
  await renderPermissions();
  const result = await requestBookmarkPreview("all");
  setButtonBusy(elements.readBookmarks, false, "授权并读取");
  if (result?.ok) {
    elements.importEmpty.hidden = true;
    elements.importPreview.hidden = false;
    elements.importTask.hidden = true;
  }
}

async function refreshBookmarkPreview() {
  const selectedRootId = elements.importSource.value || "all";
  setButtonBusy(elements.refreshImportPreview, true, "读取中…");
  await requestBookmarkPreview(selectedRootId);
  setButtonBusy(elements.refreshImportPreview, false, "重新读取");
}

async function requestBookmarkPreview(selectedRootId) {
  hideImportResult();
  const result = await chrome.runtime.sendMessage({
    type: "PREVIEW_BOOKMARK_IMPORT",
    selectedRootId,
    defaultGroupId: elements.importDefaultGroup.value || originalSettings.defaultGroupId
  });
  if (!result?.ok) {
    showImportResult(result?.error || "读取 Chrome 书签失败。", true);
    return result;
  }

  currentImportPreview = result;
  renderImportSourceOptions(result.sourceOptions, selectedRootId);
  renderImportPreview(result);
  return result;
}

function renderImportSourceOptions(sourceOptions, selectedRootId) {
  elements.importSource.replaceChildren();
  for (const source of sourceOptions || []) {
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = `${source.label} · ${source.bookmarkCount} 条`;
    option.selected = source.id === selectedRootId;
    elements.importSource.append(option);
  }
}

function renderImportPreview(result) {
  const preview = result.preview || {};
  closeImportDetail();
  elements.importTotalCount.textContent = String(preview.totalBookmarks || 0);
  elements.importBookmarkCount.textContent = String(preview.importableBookmarks || 0);
  elements.importGroupCount.textContent = String(preview.groupCount || 0);
  elements.importLooseCount.textContent = String(preview.looseBookmarkCount || 0);
  elements.importBatchCount.textContent = String(preview.batchCount || 0);
  elements.importSkipCount.textContent = String(preview.skippedBookmarks || 0);
  elements.importStateBadge.textContent = "等待确认";
  elements.importStateBadge.className = "permission-badge granted";
  elements.importConfirm.checked = false;

  elements.importGroupChips.replaceChildren();
  const groups = result.groups || [];
  if (!groups.length) {
    const empty = document.createElement("span");
    empty.className = "import-group-empty";
    empty.textContent = "没有用户文件夹，所有书签将进入默认分组";
    elements.importGroupChips.append(empty);
  } else {
    for (const group of groups.slice(0, 8)) {
      const chip = document.createElement("span");
      chip.textContent = group.name;
      chip.title = group.path?.join(" / ") || group.name;
      elements.importGroupChips.append(chip);
    }
    if (groups.length > 8) {
      const more = document.createElement("span");
      more.textContent = `另有 ${groups.length - 8} 个`;
      elements.importGroupChips.append(more);
    }
  }
  updateImportStartState();
  if ((preview.groupCount || 0) > 100) {
    showImportResult("所选范围超过 100 个用户文件夹，请改选较小的子树。", true);
  } else if (!(preview.importableBookmarks || 0)) {
    showImportResult("所选范围没有可导入的 HTTP(S) 书签。", true);
  }
}

function importDetailItems(kind) {
  const details = currentImportPreview?.details || {};
  return kind === "loose"
    ? Array.isArray(details.looseBookmarks) ? details.looseBookmarks : []
    : Array.isArray(details.skippedBookmarks) ? details.skippedBookmarks : [];
}

function selectedImportGroupName() {
  const groupId = elements.importDefaultGroup.value;
  return availableGroups.find((group) => group.id === groupId)?.name || "所选默认分组";
}

function toggleImportDetail(kind) {
  if (activeImportDetail === kind && !elements.importDetailPanel.hidden) {
    closeImportDetail();
    return;
  }
  activeImportDetail = kind;
  visibleImportDetailCount = 50;
  elements.importDetailPanel.hidden = false;
  renderImportDetail();
}

function closeImportDetail() {
  activeImportDetail = null;
  elements.importDetailPanel.hidden = true;
  elements.importLooseDetailToggle.setAttribute("aria-expanded", "false");
  elements.importSkipDetailToggle.setAttribute("aria-expanded", "false");
}

function loadMoreImportDetail() {
  visibleImportDetailCount += 50;
  renderImportDetail();
}

function renderImportDetail() {
  if (!activeImportDetail) return;
  const loose = activeImportDetail === "loose";
  const items = importDetailItems(activeImportDetail);
  const toggle = loose ? elements.importLooseDetailToggle : elements.importSkipDetailToggle;
  const otherToggle = loose ? elements.importSkipDetailToggle : elements.importLooseDetailToggle;
  toggle.setAttribute("aria-expanded", "true");
  otherToggle.setAttribute("aria-expanded", "false");
  elements.importDetailEyebrow.textContent = `${items.length} 条预览明细`;
  elements.importDetailTitle.textContent = loose
    ? `进入「${selectedImportGroupName()}」`
    : "跳过的非网页书签";
  elements.importDetailList.replaceChildren();

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "import-detail-empty";
    empty.textContent = loose
      ? "当前范围没有直接进入默认分组的书签。"
      : "当前范围没有需要跳过的非网页书签。";
    elements.importDetailList.append(empty);
  } else {
    for (const item of items.slice(0, visibleImportDetailCount)) {
      const row = document.createElement("article");
      row.className = "import-detail-row";

      const identity = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = item.title || "未命名书签";
      title.title = title.textContent;
      const location = document.createElement("small");
      location.textContent = item.sourceLocation || "Chrome 书签";
      location.title = location.textContent;
      identity.append(title, location);

      const url = document.createElement("span");
      url.className = "import-detail-url";
      url.textContent = item.url || "无地址";
      url.title = url.textContent;

      const outcome = document.createElement("span");
      outcome.className = "import-detail-reason";
      outcome.textContent = loose ? `目标：${selectedImportGroupName()}` : item.reason || "不支持的地址";
      row.append(identity, url, outcome);
      elements.importDetailList.append(row);
    }
  }

  const remaining = Math.max(0, items.length - visibleImportDetailCount);
  elements.loadMoreImportDetail.hidden = remaining === 0;
  elements.loadMoreImportDetail.textContent = `继续显示 ${Math.min(50, remaining)} 条（还剩 ${remaining} 条）`;
}

function updateImportStartState() {
  const preview = currentImportPreview?.preview;
  elements.startBookmarkImport.disabled = !elements.importConfirm.checked
    || !preview?.importableBookmarks
    || preview.groupCount > 100
    || !elements.importDefaultGroup.value;
}

async function startBookmarkImport() {
  if (!elements.importConfirm.checked) return;
  setButtonBusy(elements.startBookmarkImport, true, "正在创建任务…");
  hideImportResult();
  const result = await chrome.runtime.sendMessage({
    type: "START_BOOKMARK_IMPORT",
    selectedRootId: elements.importSource.value || "all",
    defaultGroupId: elements.importDefaultGroup.value || originalSettings.defaultGroupId
  });
  setButtonBusy(elements.startBookmarkImport, false, "确认并开始导入");
  if (!result?.ok) {
    showImportResult(result?.error || "无法开始导入。", true);
    updateImportStartState();
    return;
  }
  currentImportPreview = null;
  closeImportDetail();
  renderBookmarkImportTask(result.task);
}

async function renderBookmarkImportStatus() {
  const result = await chrome.runtime.sendMessage({ type: "GET_BOOKMARK_IMPORT_STATUS" });
  if (result?.task) renderBookmarkImportTask(result.task);
}

function renderBookmarkImportTask(task) {
  elements.importEmpty.hidden = true;
  elements.importPreview.hidden = true;
  elements.importTask.hidden = false;
  const progress = task.totalBatches
    ? Math.round((task.completedBatches / task.totalBatches) * 100)
    : 0;
  const labels = {
    ready: ["任务已创建", "等待开始"],
    running: ["后台导入中", "正在同步书签"],
    paused: ["导入已暂停", "等待恢复连接"],
    completed: ["导入完成", "书签已整理到栖页"],
    cancelled: ["任务已取消", "已保留完成的批次"]
  };
  const [badge, title] = labels[task.status] || ["导入任务", "状态更新中"];
  elements.importStateBadge.textContent = badge;
  elements.importStateBadge.className = `permission-badge ${task.status === "completed" ? "granted" : task.status === "paused" ? "denied" : ""}`;
  elements.importTaskEyebrow.textContent = `${task.sourceLabel} · ${task.preview.importableBookmarks} 条`;
  elements.importTaskTitle.textContent = title;
  elements.importProgressLabel.textContent = `${task.completedBatches} / ${task.totalBatches} 批`;
  elements.importProgressBar.style.width = `${progress}%`;
  elements.importProgressTrack.setAttribute("aria-valuenow", String(progress));
  elements.importCreatedCount.textContent = String(task.summary.created || 0);
  elements.importDuplicateCount.textContent = String(task.summary.duplicate || 0);
  elements.importInvalidCount.textContent = String(task.summary.invalid || 0);
  elements.importFailedCount.textContent = String(task.summary.failed || 0);
  elements.importTaskError.hidden = !task.lastError;
  elements.importTaskError.textContent = task.lastError ? `最近错误：${task.lastError}` : "";

  if (task.status === "running" || task.status === "ready") {
    elements.importTaskNote.textContent = "可以关闭设置页，扩展会保存清单和批次进度并在后台继续。";
  } else if (task.status === "paused") {
    elements.importTaskNote.textContent = task.nextRetryAt
      ? `将在 ${new Date(task.nextRetryAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 自动重试，也可以现在继续。`
      : "请检查 API 设置或令牌，修正后点击继续导入。";
  } else if (task.status === "completed") {
    elements.importTaskNote.textContent = `共处理 ${task.summary.total} 条；重复书签不会再次创建。`;
  } else {
    elements.importTaskNote.textContent = "已停止后续批次；服务端已完成的批次不会回滚。";
  }

  const terminal = task.status === "completed" || task.status === "cancelled";
  elements.resumeBookmarkImport.hidden = terminal;
  elements.cancelBookmarkImport.hidden = terminal;
  elements.newBookmarkImport.hidden = !terminal;
}

async function resumeBookmarkImport() {
  setButtonBusy(elements.resumeBookmarkImport, true, "正在继续…");
  const result = await chrome.runtime.sendMessage({ type: "RESUME_BOOKMARK_IMPORT" });
  setButtonBusy(elements.resumeBookmarkImport, false, "继续导入");
  if (!result?.ok) showImportResult(result?.error || "无法继续导入。", true);
  await renderBookmarkImportStatus();
}

async function cancelBookmarkImport() {
  if (!confirm("确定取消当前导入吗？已完成的批次会保留，尚未发送的书签不会上传。")) return;
  setButtonBusy(elements.cancelBookmarkImport, true, "正在取消…");
  const result = await chrome.runtime.sendMessage({ type: "CANCEL_BOOKMARK_IMPORT" });
  setButtonBusy(elements.cancelBookmarkImport, false, "取消任务");
  if (result?.task) renderBookmarkImportTask(result.task);
}

async function resetBookmarkImport() {
  const result = await chrome.runtime.sendMessage({ type: "CLEAR_BOOKMARK_IMPORT" });
  if (!result?.ok) {
    showImportResult(result?.error || "无法开始新任务。", true);
    return;
  }
  currentImportPreview = null;
  elements.importTask.hidden = true;
  elements.importPreview.hidden = true;
  elements.importEmpty.hidden = false;
  elements.importStateBadge.textContent = "未读取";
  elements.importStateBadge.className = "permission-badge";
  hideImportResult();
}

function showImportResult(message, isError) {
  elements.importResult.textContent = message;
  elements.importResult.className = `inline-result visible ${isError ? "error" : "success"}`;
}

function hideImportResult() {
  elements.importResult.textContent = "";
  elements.importResult.className = "inline-result";
}

async function renderPermissions() {
  // Safari 或缺少 chrome.permissions 运行时 API 时按已授权显示（host 权限不豁免 CORS，无需 origins 权限）。
  const apiGranted = NavShared.shouldUseHostPermissions()
    ? await hasApiPermission(elements.apiBaseUrl.value || originalSettings.apiBaseUrl)
    : true;
  const bookmarkGranted = NavShared.isPermissionsApiCallable()
    ? await NavShared.safePermissionsContains(undefined, { permissions: ["bookmarks"] }, Boolean(chrome.bookmarks?.getTree))
    : Boolean(chrome.bookmarks?.getTree);
  setPermissionBadge(elements.apiPermission, apiGranted, apiGranted ? "已授权" : "待授权");
  setPermissionBadge(
    elements.bookmarkPermission,
    bookmarkGranted,
    bookmarkGranted
      ? elements.autoSync.checked ? "已启用" : "导入已授权"
      : "未启用"
  );
}

async function hasApiPermission(value) {
  // Safari 或缺少 chrome.permissions 运行时 API 时视为已授权。
  if (!NavShared.shouldUseHostPermissions()) return true;
  try {
    return await NavShared.safePermissionsContains(undefined, { origins: [NavShared.buildPermissionOrigin(value)] }, true);
  } catch {
    return false;
  }
}

function setPermissionBadge(element, granted, text) {
  element.textContent = text;
  element.classList.toggle("granted", granted);
  element.classList.toggle("denied", !granted);
  element.classList.remove("pending");
}

function renderNewTabBadge() {
  const enabled = elements.newTabEnabled.checked;
  elements.newTabPermission.textContent = enabled ? "已开启" : "默认关闭";
  elements.newTabPermission.classList.toggle("granted", enabled);
  elements.newTabPermission.classList.toggle("denied", !enabled);
  elements.newTabPermission.classList.remove("pending");
}

async function renderQueue() {
  const result = await chrome.runtime.sendMessage({ type: "GET_QUEUE_STATUS" });
  const count = result?.count || 0;
  elements.queueCount.textContent = `${count} 条`;
  elements.queueState.classList.toggle("has-items", count > 0);
  elements.retryQueue.disabled = count === 0;
  elements.clearQueue.disabled = count === 0;

  const symbol = elements.queueState.querySelector(".queue-symbol");
  const title = elements.queueState.querySelector("strong");
  const detail = elements.queueState.querySelector("p");
  if (!count) {
    symbol.textContent = "✓";
    title.textContent = "队列为空";
    detail.textContent = "所有收藏都已同步。";
  } else {
    symbol.textContent = String(count > 9 ? "9+" : count);
    title.textContent = `${count} 条收藏等待同步`;
    detail.textContent = result.lastError ? `最近错误：${result.lastError}` : "连接恢复后会自动重试。";
  }
}

async function retryQueue() {
  setButtonBusy(elements.retryQueue, true, "同步中…");
  const result = await chrome.runtime.sendMessage({ type: "RETRY_QUEUE" });
  setButtonBusy(elements.retryQueue, false, "立即重试");
  await renderQueue();
  if (result?.synced) showResult(`已成功同步 ${result.synced} 条收藏。`, "success");
}

async function clearQueue() {
  if (!confirm("确定清空所有待同步收藏吗？此操作无法撤销。")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_QUEUE" });
  await renderQueue();
  showResult("待同步队列已清空。", "success");
}

function toggleTokenVisibility() {
  const show = elements.token.type === "password";
  elements.token.type = show ? "text" : "password";
  elements.toggleToken.textContent = show ? "隐藏" : "显示";
  elements.toggleToken.setAttribute("aria-label", show ? "隐藏令牌" : "显示令牌");
}

function markDirty() {
  elements.saveIndicator.textContent = "有未保存的修改";
  elements.saveIndicator.classList.remove("saved");
}

function showFieldError(message) {
  elements.apiError.textContent = message;
  elements.apiBaseUrl.classList.add("invalid");
  elements.apiBaseUrl.focus();
}

function clearFieldError() {
  elements.apiError.textContent = "";
  elements.apiBaseUrl.classList.remove("invalid");
}

function showResult(message, type) {
  elements.connectionResult.textContent = message;
  elements.connectionResult.className = `inline-result visible${type ? ` ${type}` : ""}`;
}

function setButtonBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = label;
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}
