"use strict";

const SETTINGS_KEY = "navIngestSettings";
const elements = {
  connection: document.querySelector("#connection"),
  form: document.querySelector("#save-form"),
  group: document.querySelector("#group"),
  host: document.querySelector("#host"),
  openHome: document.querySelector("#open-home"),
  openOptions: document.querySelector("#open-options"),
  pageCard: document.querySelector("#page-card"),
  pageTitle: document.querySelector("#page-title"),
  queue: document.querySelector("#queue"),
  saveButton: document.querySelector("#save-button"),
  buttonLabel: document.querySelector("#button-label"),
  siteIcon: document.querySelector("#site-icon"),
  status: document.querySelector("#status"),
  title: document.querySelector("#title")
};

let currentTab = null;
let settings = NavShared.mergeSettings();
let apiPermissionGranted = false;

document.addEventListener("DOMContentLoaded", initialize);
elements.form.addEventListener("submit", handleSave);
elements.openHome.addEventListener("click", () => void openNavigationHome());
elements.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

async function openNavigationHome() {
  clearStatus();
  elements.openHome.disabled = true;
  try {
    const homeUrl = `${NavShared.normalizeApiBaseUrl(settings.apiBaseUrl)}/`;
    await chrome.tabs.create({ url: homeUrl });
    window.close();
  } catch (error) {
    elements.openHome.disabled = false;
    const detail = typeof error?.message === "string" && error.message ? `：${error.message}` : "";
    showStatus(`无法打开导航主页${detail}`, "error");
  }
}

async function initialize() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = NavShared.mergeSettings(stored[SETTINGS_KEY]);

  // 缺少 chrome.permissions 运行时 API 或 Safari（host 权限不豁免 CORS、origins 权限会挂起）时视为已授权。
  if (NavShared.shouldUseHostPermissions()) {
    try {
      apiPermissionGranted = await NavShared.safePermissionsContains(undefined, {
        origins: [NavShared.buildPermissionOrigin(settings.apiBaseUrl)]
      }, true);
    } catch {
      apiPermissionGranted = false;
    }
  } else {
    apiPermissionGranted = true;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  renderTab();
  renderPermission();
  await Promise.all([loadGroups(), loadQueueStatus()]);
}

function renderTab() {
  const valid = NavShared.isSavableUrl(currentTab?.url);
  elements.pageCard.setAttribute("aria-busy", "false");
  elements.title.value = currentTab?.title || "";
  elements.pageTitle.textContent = currentTab?.title || "无标题页面";

  if (!valid) {
    elements.host.textContent = "此页面不可保存";
    elements.siteIcon.textContent = "-";
    elements.saveButton.disabled = true;
    showStatus("仅支持 http:// 或 https:// 网页", "error");
    return;
  }

  const pageUrl = new URL(currentTab.url);
  elements.host.textContent = pageUrl.hostname;
  renderFavicon(currentTab.favIconUrl, pageUrl.hostname);
  elements.saveButton.disabled = !apiPermissionGranted;
}

function renderFavicon(favIconUrl, hostname) {
  elements.siteIcon.replaceChildren();
  if (NavShared.isSavableUrl(favIconUrl)) {
    const image = document.createElement("img");
    image.src = favIconUrl;
    image.alt = "";
    image.addEventListener("error", () => {
      elements.siteIcon.textContent = firstGlyph(hostname);
    }, { once: true });
    elements.siteIcon.append(image);
  } else {
    elements.siteIcon.textContent = firstGlyph(hostname);
  }
}

function renderPermission() {
  elements.connection.classList.toggle("ready", apiPermissionGranted);
  elements.connection.classList.toggle("missing", !apiPermissionGranted);
  elements.connection.lastChild.textContent = apiPermissionGranted ? " 已授权 API" : " 需要配置 API";
  if (!apiPermissionGranted && NavShared.isSavableUrl(currentTab?.url)) {
    showStatus("请先在设置中保存 API 地址并授权访问", "warning");
  }
}

async function loadGroups() {
  appendGroupOption(settings.defaultGroupId, settings.defaultGroupId);
  if (!apiPermissionGranted) return;

  const result = await chrome.runtime.sendMessage({ type: "GET_GROUPS" });
  if (!result?.groups?.length) return;

  elements.group.replaceChildren();
  for (const group of result.groups) appendGroupOption(group.id, group.name);
  if (![...elements.group.options].some((option) => option.value === settings.defaultGroupId)) {
    appendGroupOption(settings.defaultGroupId, settings.defaultGroupId);
  }
  elements.group.value = settings.defaultGroupId;
}

function appendGroupOption(id, name) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = name;
  elements.group.append(option);
}

async function loadQueueStatus() {
  const result = await chrome.runtime.sendMessage({ type: "GET_QUEUE_STATUS" });
  elements.queue.textContent = result?.count ? `${result.count} 条待同步` : "队列为空";
}

async function handleSave(event) {
  event.preventDefault();
  if (!apiPermissionGranted) {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (!NavShared.isSavableUrl(currentTab?.url)) return;

  setSaving(true);
  clearStatus();
  const result = await chrome.runtime.sendMessage({
    type: "SAVE_BOOKMARK",
    bookmark: {
      url: currentTab.url,
      title: elements.title.value.trim() || currentTab.title,
      groupId: elements.group.value,
      trigger: "toolbar"
    }
  });

  setSaving(false);
  if (result?.ok && result.status === "saved") {
    const privateUrl = result.response?.metadata?.status === "skipped"
      && result.response?.metadata?.code === "private_url";
    showStatus(
      privateUrl ? "内网网址已保存，图标与介绍未自动获取" : "已保存，导航站正在补全图标与介绍",
      "success"
    );
    elements.buttonLabel.textContent = "已保存";
    setTimeout(() => window.close(), 950);
  } else if (result?.ok && result.status === "queued") {
    showStatus("当前无法连接，已加入待同步队列", "warning");
    await loadQueueStatus();
  } else {
    showStatus(result?.error || "保存失败，请检查设置", "error");
  }
}

function setSaving(saving) {
  elements.saveButton.disabled = saving;
  elements.buttonLabel.textContent = saving ? "正在保存…" : "保存到导航站";
}

function showStatus(message, type) {
  elements.status.textContent = message;
  elements.status.className = `status visible${type ? ` ${type}` : ""}`;
}

function clearStatus() {
  elements.status.textContent = "";
  elements.status.className = "status";
}

function firstGlyph(hostname) {
  return String(hostname || "栖").replace(/^www\./, "").charAt(0).toUpperCase();
}
