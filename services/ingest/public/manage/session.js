"use strict";

async function handleLogin(event) {
  event.preventDefault();
  const username = elements.loginUsername.value.trim();
  const password = elements.loginPassword.value;
  if (!username || !password) {
    elements.loginError.textContent = "请输入用户名和密码";
    return;
  }

  setButtonBusy(elements.loginSubmit, true, "正在登录");
  elements.loginError.textContent = "";
  try {
    const session = await authRequest("/login", {
      method: "POST",
      body: { username, password }
    });
    elements.loginPassword.value = "";
    await enterManager(session);
  } catch (error) {
    elements.loginPassword.value = "";
    elements.loginError.textContent = error instanceof ApiError && error.status === 401
      ? "用户名或密码不正确"
      : error instanceof ApiError && error.status === 429
        ? "登录尝试过多，请稍后再试"
        : readableError(error);
    elements.loginPassword.focus();
  } finally {
    setButtonBusy(elements.loginSubmit, false, "登录管理页");
  }
}

async function restoreSession() {
  try {
    const session = await authRequest("/session");
    await enterManager(session);
  } catch (error) {
    showLogin(error instanceof ApiError && error.status === 401 ? "" : readableError(error));
  }
}

async function enterManager(session) {
  state.csrfToken = String(session?.csrfToken || "");
  state.username = String(session?.username || "");
  if (!state.csrfToken) throw new Error("登录响应缺少 CSRF Token");
  elements.logoutButton.title = state.username ? `退出 ${state.username}` : "退出网址管理";
  elements.loginView.hidden = true;
  elements.app.hidden = false;
  await loadCatalog({ authenticating: true });
  elements.globalSearch.focus();
}

function showLogin(message = "") {
  closeItemDrawer();
  closeDialogs();
  state.csrfToken = "";
  state.username = "";
  state.aiConfig = null;
  state.aiJob = null;
  clearTimeout(state.aiPollTimer);
  state.aiPollTimer = null;
  clearTimeout(state.healthPollTimer);
  state.healthPollTimer = null;
  state.healthJob = null;
  elements.logoutButton.title = "退出网址管理";
  state.catalog = NavManageCore.normalizeCatalog({ version: "", groups: [] });
  state.currentGroupId = null;
  state.query = "";
  elements.globalSearch.value = "";
  elements.loginPassword.value = "";
  elements.app.hidden = true;
  elements.loginView.hidden = false;
  elements.loginError.textContent = message;
  (elements.loginUsername.value ? elements.loginPassword : elements.loginUsername).focus();
}

async function logout() {
  setButtonBusy(elements.logoutButton, true, "正在退出");
  try {
    await authRequest("/logout", {
      method: "POST",
      csrf: true,
      expectEmpty: true
    });
    showLogin("已安全退出管理页");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) showLogin("登录已失效，请重新登录");
    else showToastMessage(readableError(error), "error");
  } finally {
    setButtonBusy(elements.logoutButton, false, "退出");
  }
}

function toggleLoginPassword() {
  const willShow = elements.loginPassword.type === "password";
  elements.loginPassword.type = willShow ? "text" : "password";
  setButtonVisual(elements.toggleLoginPassword, willShow ? "隐藏" : "显示");
}

async function changeAdminPassword(event) {
  event.preventDefault();
  const currentPassword = document.querySelector("#current-password").value;
  const newPassword = document.querySelector("#new-password").value;
  const confirmation = document.querySelector("#confirm-password").value;
  const errorBox = document.querySelector("#password-error");
  const button = document.querySelector("#save-password");
  errorBox.textContent = "";
  if (newPassword !== confirmation) { errorBox.textContent = "两次输入的新密码不一致"; return; }
  if (newPassword.length < 12 || new TextEncoder().encode(newPassword).length > 1024) { errorBox.textContent = "新密码至少 12 个字符，且不超过 1024 字节"; return; }
  if (newPassword === currentPassword) { errorBox.textContent = "新密码不能与当前密码相同"; return; }
  setButtonBusy(button, true, "正在保存");
  try {
    await authRequest("/password", { method: "POST", body: { currentPassword, newPassword }, csrf: true });
    document.querySelector("#password-form").reset();
    showLogin("密码已修改，请使用新密码重新登录");
  } catch (error) {
    errorBox.textContent = error instanceof ApiError && error.status === 401 ? "当前密码不正确，或登录已失效" : error instanceof ApiError && error.status === 429 ? "尝试过多，请稍后再试" : readableError(error);
  } finally { setButtonBusy(button, false, "保存新密码并退出"); }
}
