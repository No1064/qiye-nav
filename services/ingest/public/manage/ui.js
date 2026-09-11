"use strict";

function closeDialogs() {
  clearTimeout(state.aiPollTimer);
  state.aiPollTimer = null;
  if (elements.groupDialog.open) elements.groupDialog.close();
  if (elements.settingsDialog.open) elements.settingsDialog.close();
  const passwordDialog = document.querySelector("#password-dialog");
  if (passwordDialog?.open) passwordDialog.close();
  if (elements.aiDialog.open) elements.aiDialog.close();
  if (elements.healthDialog.open) elements.healthDialog.close();
  const transfer = document.querySelector("#transfer-dialog");
  if (transfer?.open) transfer.close();
  if (elements.confirmDialog.open) elements.confirmDialog.close();
}

function showToastMessage(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast${type === "error" ? " error" : ""}`;
  toast.textContent = message;
  elements.toastRegion.append(toast);
  // A modal dialog lives in the top layer; z-index alone cannot put a toast above it.
  if (typeof elements.toastRegion.showPopover === "function") {
    if (elements.toastRegion.matches(":popover-open")) elements.toastRegion.hidePopover();
    elements.toastRegion.showPopover();
  } else {
    const dialogs = [...document.querySelectorAll("dialog[open]")];
    (dialogs[dialogs.length - 1] || document.body).append(elements.toastRegion);
  }
  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => {
      toast.remove();
      if (!elements.toastRegion.childElementCount && typeof elements.toastRegion.hidePopover === "function" && elements.toastRegion.matches(":popover-open")) elements.toastRegion.hidePopover();
    }, 200);
  }, type === "error" ? 4800 : 2800);
}

function setButtonBusy(button, busy, text) {
  button.disabled = busy;
  setButtonVisual(button, text, !busy);
  button.setAttribute("aria-busy", String(busy));
}

function setButtonVisual(button, text, showIcon = true) {
  button.replaceChildren();
  if (showIcon && button.dataset.icon) button.append(createIcon(button.dataset.icon));
  const label = document.createElement("span");
  label.textContent = text;
  button.append(label);
}

function createIcon(name, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `icon ${className}`.trim());
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `./icons.svg#icon-${name}`);
  svg.append(use);
  return svg;
}

function readableError(error) {
  if (!error) return "发生未知错误";
  if (error.message === "Failed to fetch") return "无法连接管理 API，请检查服务状态";
  const structuredBody = error.body || (error.error || error.code ? error : null);
  const apiMessage = structuredBody
    ? NavManageCore.responseErrorMessage(structuredBody, error.status || 500)
    : "";
  if (apiMessage) return apiMessage.slice(0, 300);
  if (typeof error.message === "string" && error.message.trim()) return error.message.slice(0, 300);
  if (error.message && typeof error.message === "object") {
    const nested = error.message.message || error.message.detail || error.message.reason;
    if (typeof nested === "string" && nested.trim()) return nested.slice(0, 300);
  }
  if (typeof error === "string" && error.trim()) return error.slice(0, 300);
  return "请求失败，请稍后重试";
}

function firstGlyph(value) {
  return String(value || "网").trim().charAt(0).toLocaleUpperCase("zh-CN");
}

function isImageUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate || (!candidate.startsWith("/") && !/^https?:\/\//i.test(candidate))) return false;
  try {
    const parsed = new URL(candidate, location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function faviconUrl(item) {
  if (isImageUrl(item.icon)) return item.icon;
  const iconValue = String(item.icon || "").trim().toLowerCase();
  if (iconValue && iconValue !== "favicon") return "";
  try {
    const parsed = new URL(item.url);
    if (!/^https?:$/.test(parsed.protocol) || isPrivateHostname(parsed.hostname)) return "";
    return `https://icon.horse/icon/${encodeURIComponent(parsed.hostname)}`;
  } catch {
    return "";
  }
}

function isPrivateHostname(hostname) {
  const value = String(hostname).toLowerCase();
  if (value === "localhost" || value.endsWith(".local")) return true;
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(value)) return true;
  const match = value.match(/^172\.(\d{1,3})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function segment(value) {
  return encodeURIComponent(String(value));
}
