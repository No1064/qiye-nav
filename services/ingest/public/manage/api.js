"use strict";

async function authRequest(path, options = {}) {
  return requestJson(`${API_ROOT}/auth${path}`, options);
}

async function apiRequest(path, options = {}) {
  const method = options.method || "GET";
  const isMutation = !["GET", "HEAD"].includes(method);
  try {
    return await requestJson(`${API_ROOT}${path}`, {
      ...options,
      headers: {
        ...(isMutation && state.csrfToken ? { "X-CSRF-Token": state.csrfToken } : {}),
        ...((options.versioned ?? (method !== "GET" && path !== "/metadata/preview")) && state.catalog.version
          ? { "If-Match": state.catalog.version }
          : {})
      }
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) showLogin("登录已失效，请重新登录");
    throw error;
  }
}

async function requestJson(url, options = {}) {
  const method = options.method || "GET";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = {
    Accept: "application/json",
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(options.csrf && state.csrfToken ? { "X-CSRF-Token": state.csrfToken } : {}),
    ...(options.headers || {})
  };

  try {
    const response = await fetch(url, {
      method,
      headers,
      credentials: "same-origin",
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal
    });
    if (options.expectEmpty && response.ok && response.status === 204) return {};
    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text.slice(0, 300) };
      }
    }
    if (!response.ok) throw new ApiError(response.status, body);
    return body;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

