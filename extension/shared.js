(function attachShared(root, factory) {
  const api = factory();
  root.NavShared = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis, function createShared() {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    apiBaseUrl: "http://127.0.0.1:8787",
    token: "",
    defaultGroupId: "inbox",
    autoSyncBookmarks: false,
    newTabEnabled: false
  });

  function normalizeApiBaseUrl(value) {
    const candidate = String(value || "").trim();
    if (!candidate) {
      throw new Error("请填写 API 地址");
    }

    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("API 地址格式不正确");
    }

    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error("API 地址仅支持 HTTP 或 HTTPS");
    }
    if (parsed.username || parsed.password) {
      throw new Error("API 地址中不能包含用户名或密码");
    }
    if (parsed.search || parsed.hash) {
      throw new Error("API 地址中不能包含查询参数或锚点");
    }

    // Safari/WebKit 对扩展后台 fetch 强制 CORS 且 localhost 可能优先解析为 IPv6 ::1，
    // 而本地服务只监听 IPv4 回环，导致连接挂起。统一规范化为 127.0.0.1 避开 ::1 解析。
    if (parsed.hostname === "localhost") {
      parsed.hostname = "127.0.0.1";
    }

    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  }

  function buildPermissionOrigin(baseUrl) {
    const parsed = new URL(normalizeApiBaseUrl(baseUrl));
    return `${parsed.protocol}//${parsed.host}/*`;
  }

  /**
   * 检测当前是否为 Safari Web Extension 环境。
   * Safari 同时暴露 chrome.* 与 browser.* 命名空间，但引擎是 WebKit。
   * 用 chrome.engines.webKit 或 UA（含 AppleWebKit 且不含 Chromium）双重判定。
   * @param {object} [chromeRef] 显式传入 chrome 对象（测试注入）；缺省用全局 chrome。
   */
  function isSafari(chromeRef) {
    const target = typeof chromeRef !== "undefined" ? chromeRef : globalThis.chrome;
    return Boolean(target?.engines?.webKit)
      || (typeof navigator !== "undefined"
          && /AppleWebKit/.test(navigator.userAgent)
          && !/Chrome|CriOS|Edg/i.test(navigator.userAgent));
  }

  /**
   * 环境是否提供 chrome.permissions 运行时 API。
   * 注意：Safari 14+ 与 Chromium 都支持 chrome.permissions（contains/request/remove），
   * 因此这里仅在 chrome 对象缺失或缺少 permissions 子对象时返回 false。
   * @param {object} [chromeRef] 当前环境的 chrome 对象；扩展内通常省略，测试注入时显式传入。
   */
  function hasPermissionsApi(chromeRef) {
    const target = typeof chromeRef !== "undefined" ? chromeRef : globalThis.chrome;
    return Boolean(target) && Boolean(target.permissions)
      && typeof target.permissions.contains === "function";
  }

  /**
   * 环境是否允许调用 chrome.permissions.request / remove。
   * Safari 的 chrome.permissions 运行时调用（含 request/remove/contains）会挂起不返回，
   * 且 Safari 不支持 chrome.bookmarks，因此 Safari 下视为不可调用，回退到声明式模型。
   * @param {object} [chromeRef]
   */
  function canRequestPermissions(chromeRef) {
    const target = typeof chromeRef !== "undefined" ? chromeRef : globalThis.chrome;
    return !isSafari(chromeRef) && hasPermissionsApi(target)
      && Boolean(target?.permissions?.request)
      && typeof target.permissions.request === "function"
      && typeof target.permissions.remove === "function";
  }

  /**
   * 判断 chrome.permissions 运行时 API 是否可被实际、安全地调用。
   * Safari 14+ 暴露了 chrome.permissions 对象，但其 contains/request/remove 调用会挂起
   * （见 WebKit bug 290508），因此 Safari 下视为不可调用，避免 await 永不 resolve 卡死 UI。
   * @param {object} [chromeRef]
   */
  function isPermissionsApiCallable(chromeRef) {
    return !isSafari(chromeRef) && hasPermissionsApi(chromeRef);
  }

  /**
   * 当前环境是否应当使用 host（origins）运行时权限。
   * Safari/WebKit 对扩展后台 fetch 强制 CORS，host 权限不豁免 CORS（与 Chrome 相反），
   * 且 chrome.permissions 的 origins 分支在 Safari 上会挂起不返回（见 WebKit bug 290508/290764）。
   * 因此 Safari 下应完全跳过 origins 权限的 request/contains/remove，直接放行去 fetch
   * （服务端已通过 CORS_ALLOWED_ORIGINS 放行跨域）。仅 Chromium 等真正依赖 host 权限的环境才走运行时申请。
   * @param {object} [chromeRef]
   */
  function shouldUseHostPermissions(chromeRef) {
    return !isSafari(chromeRef) && hasPermissionsApi(chromeRef);
  }

  const PERMISSION_TIMEOUT_MS = 3_000;

  /**
   * 给 Promise 加超时保护：超时后 resolve 为 fallback，绝不永久挂起、绝不因超时 reject。
   * 用于 chrome.permissions 等可能在 Safari 上挂起不返回的运行时 API。
   * @param {Promise} promise 要保护的 Promise。
   * @param {number} ms 超时毫秒数。
   * @param {*} fallback 超时或 reject 时的兜底值。
   */
  function withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(fallback), ms);
      Promise.resolve(promise).then(finish, () => finish(fallback));
    });
  }

  /**
   * 带超时保护的 chrome.permissions.contains。
   * API 不可用或调用超时/reject 时 resolve 为 fallback（默认 true = 放行）。
   * @param {object} [chromeRef]
   * @param {object} query permissions 查询参数。
   * @param {*} [fallback] 超时/异常兜底值，默认 true。
   */
  function safePermissionsContains(chromeRef, query, fallback) {
    const target = typeof chromeRef !== "undefined" ? chromeRef : globalThis.chrome;
    const fb = typeof fallback !== "undefined" ? fallback : true;
    if (!hasPermissionsApi(target)) return Promise.resolve(fb);
    return withTimeout(target.permissions.contains(query), PERMISSION_TIMEOUT_MS, fb);
  }

  /**
   * 带超时保护的 chrome.permissions.request。
   * API 不可用或调用超时/reject 时 resolve 为 fallback（默认 true = 视为已授权继续流程）。
   * @param {object} [chromeRef]
   * @param {object} query permissions 请求参数。
   * @param {*} [fallback] 超时/异常兜底值，默认 true。
   */
  function safePermissionsRequest(chromeRef, query, fallback) {
    const target = typeof chromeRef !== "undefined" ? chromeRef : globalThis.chrome;
    const fb = typeof fallback !== "undefined" ? fallback : true;
    if (!canRequestPermissions(target)) return Promise.resolve(fb);
    return withTimeout(target.permissions.request(query), PERMISSION_TIMEOUT_MS, fb);
  }

  /**
   * 带超时保护的 chrome.permissions.remove。API 不可用或超时时静默 resolve 为 false。
   * @param {object} [chromeRef]
   * @param {object} query permissions 移除参数。
   */
  function safePermissionsRemove(chromeRef, query) {
    const target = typeof chromeRef !== "undefined" ? chromeRef : globalThis.chrome;
    if (!target?.permissions?.remove) return Promise.resolve(false);
    return withTimeout(target.permissions.remove(query), PERMISSION_TIMEOUT_MS, false);
  }

  function normalizeGroupId(value) {
    const group = String(value || "").trim();
    return group || DEFAULT_SETTINGS.defaultGroupId;
  }

  function isSavableUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function canonicalizeUrl(value) {
    return new URL(String(value)).toString();
  }

  function skippedBookmarkReason(value) {
    let parsed;
    try {
      parsed = new URL(String(value || ""));
    } catch {
      return "无效地址";
    }
    const reasons = {
      "about:": "浏览器内部页面",
      "chrome:": "Chrome 内部页面",
      "chrome-extension:": "扩展页面",
      "data:": "数据地址",
      "file:": "本地文件",
      "javascript:": "脚本地址"
    };
    return reasons[parsed.protocol] || `不支持 ${parsed.protocol.replace(":", "").toUpperCase()} 协议`;
  }

  function endpoint(baseUrl, path) {
    const base = normalizeApiBaseUrl(baseUrl);
    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
  }

  function calculateBackoffMs(attempts, randomValue) {
    const exponent = Math.min(Math.max(Number(attempts) || 0, 0), 10);
    const base = Math.min(30_000 * (2 ** exponent), 6 * 60 * 60 * 1000);
    const random = typeof randomValue === "number" ? randomValue : Math.random();
    return Math.round(base * (0.85 + Math.max(0, Math.min(random, 1)) * 0.3));
  }

  function extractGroups(body) {
    const source = Array.isArray(body)
      ? body
      : Array.isArray(body?.groups)
        ? body.groups
        : Array.isArray(body?.data)
          ? body.data
          : [];

    const groups = source
      .map((item) => {
        if (typeof item === "string") {
          return { id: item, name: item };
        }
        const id = item?.id ?? item?.groupId ?? item?.slug;
        const name = item?.name ?? item?.title ?? id;
        return id ? { id: String(id), name: String(name), ...(item?.parentId ? { parentId: String(item.parentId) } : {}) } : null;
      })
      .filter(Boolean);
    const byId = new Map(groups.map((group) => [group.id, group]));
    return groups.map((group) => {
      const parent = group.parentId ? byId.get(group.parentId) : null;
      return { ...group, name: parent ? `${parent.name} / ${group.name}` : group.name };
    });
  }

  function mergeSettings(value) {
    return {
      ...DEFAULT_SETTINGS,
      ...(value || {}),
      defaultGroupId: normalizeGroupId(value?.defaultGroupId)
    };
  }

  function cleanBookmarkTitle(value, fallback) {
    const title = String(value || "").trim();
    return (title || String(fallback || "未命名书签")).slice(0, 500);
  }

  function cleanFolderSegment(value) {
    return String(value || "未命名文件夹")
      .replace(/[\\/]+/g, "／")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "未命名文件夹";
  }

  function bookmarkNodeId(node) {
    return String(node?.id ?? "");
  }

  function bookmarkChildren(node) {
    return Array.isArray(node?.children) ? node.children : [];
  }

  function countBookmarkNodes(node) {
    if (node?.url) return 1;
    return bookmarkChildren(node).reduce((total, child) => total + countBookmarkNodes(child), 0);
  }

  function collectBookmarkRoots(tree) {
    return Array.isArray(tree) ? tree.filter(Boolean) : [];
  }

  function systemBookmarkRootIds(tree) {
    const ids = new Set();
    for (const root of collectBookmarkRoots(tree)) {
      ids.add(bookmarkNodeId(root));
      for (const child of bookmarkChildren(root)) {
        if (!child?.url) ids.add(bookmarkNodeId(child));
      }
    }
    return ids;
  }

  function findBookmarkNode(tree, selectedRootId) {
    const target = String(selectedRootId || "all");
    if (target === "all") return null;
    const pending = collectBookmarkRoots(tree).map((node) => ({ node, ancestors: [] }));
    while (pending.length) {
      const entry = pending.shift();
      if (bookmarkNodeId(entry.node) === target) return entry;
      pending.unshift(...bookmarkChildren(entry.node).map((node) => ({
        node,
        ancestors: [...entry.ancestors, entry.node]
      })));
    }
    return undefined;
  }

  function listBookmarkSubtrees(tree) {
    const roots = collectBookmarkRoots(tree);
    const systemIds = systemBookmarkRootIds(tree);
    const options = [{
      id: "all",
      label: "全部 Chrome 书签",
      bookmarkCount: roots.reduce((total, root) => total + countBookmarkNodes(root), 0),
      system: true
    }];

    function visit(node, labelPath) {
      if (node?.url) return;
      const id = bookmarkNodeId(node);
      const title = cleanFolderSegment(node?.title || (systemIds.has(id) ? "Chrome 书签" : "未命名文件夹"));
      const nextPath = [...labelPath, title];
      if (id && !roots.includes(node)) {
        options.push({
          id,
          label: nextPath.join(" / "),
          bookmarkCount: countBookmarkNodes(node),
          system: systemIds.has(id)
        });
      }
      for (const child of bookmarkChildren(node)) visit(child, nextPath);
    }

    for (const root of roots) {
      for (const child of bookmarkChildren(root)) visit(child, []);
    }
    return options.filter((option) => option.id === "all" || option.bookmarkCount > 0);
  }

  function buildBookmarkImportPlan(tree, options) {
    const selectedRootId = String(options?.selectedRootId || "all");
    const roots = collectBookmarkRoots(tree);
    const selectedEntry = findBookmarkNode(tree, selectedRootId);
    const selectedNode = selectedEntry?.node;
    if (selectedRootId !== "all" && !selectedEntry) {
      throw new Error("所选书签文件夹已不存在，请重新读取");
    }
    if (selectedNode?.url) throw new Error("请选择书签文件夹，而不是单个书签");

    const systemIds = systemBookmarkRootIds(tree);
    const traversalRoots = selectedRootId === "all"
      ? roots.map((node) => ({ node, userPath: [], chromePath: [] }))
      : [{
          node: selectedNode,
          userPath: selectedEntry.ancestors
            .filter((node) => !systemIds.has(bookmarkNodeId(node)))
            .map((node) => cleanFolderSegment(node.title)),
          chromePath: selectedEntry.ancestors
            .filter((node) => String(node?.title || "").trim())
            .map((node) => cleanFolderSegment(node.title))
        }];
    const bookmarks = [];
    const looseBookmarks = [];
    const skippedBookmarks = [];
    let totalBookmarks = 0;

    function visit(node, userPath, chromePath) {
      if (node?.url) {
        totalBookmarks += 1;
        const sourceLocation = chromePath.join(" / ") || "Chrome 书签";
        if (!isSavableUrl(node.url)) {
          skippedBookmarks.push({
            title: cleanBookmarkTitle(node.title, node.url),
            url: String(node.url),
            sourceLocation,
            reason: skippedBookmarkReason(node.url)
          });
          return false;
        }
        const canonicalUrl = canonicalizeUrl(node.url);
        const item = {
          sourceId: bookmarkNodeId(node) || `url-${bookmarks.length + 1}`,
          url: canonicalUrl,
          title: cleanBookmarkTitle(node.title, canonicalUrl),
          folderPath: [...userPath]
        };
        if (node.dateAdded) item.dateAdded = Number(node.dateAdded);
        bookmarks.push(item);
        if (userPath.length === 0) {
          looseBookmarks.push({ title: item.title, url: item.url, sourceLocation });
        }
        return true;
      }

      const id = bookmarkNodeId(node);
      const isSystem = systemIds.has(id);
      const nextPath = isSystem ? userPath : [...userPath, cleanFolderSegment(node?.title)];
      const nextChromePath = String(node?.title || "").trim()
        ? [...chromePath, cleanFolderSegment(node.title)]
        : chromePath;
      let hasBookmarks = false;
      for (const child of bookmarkChildren(node)) {
        hasBookmarks = visit(child, nextPath, nextChromePath) || hasBookmarks;
      }
      return hasBookmarks;
    }

    for (const root of traversalRoots) visit(root.node, root.userPath, root.chromePath);
    const hierarchyGroups = new Map();
    for (const bookmark of bookmarks) {
      const path = bookmark.folderPath;
      if (!path.length) continue;
      const rootPath = [path[0]];
      hierarchyGroups.set(JSON.stringify(rootPath), {
        sourceKey: `chrome-path:${JSON.stringify(rootPath)}`,
        name: rootPath[0], path: rootPath
      });
      if (path.length > 1) hierarchyGroups.set(JSON.stringify(path), {
        sourceKey: `chrome-path:${JSON.stringify(path)}`,
        name: path.join(" / "), path: [...path]
      });
    }
    const groups = [...hierarchyGroups.values()];

    return {
      selectedRootId,
      defaultGroupId: normalizeGroupId(options?.defaultGroupId),
      groups: groups.map(({ sourceKey, name, path }) => ({ sourceKey, name, path })),
      bookmarks,
      details: { looseBookmarks, skippedBookmarks },
      preview: {
        totalBookmarks,
        importableBookmarks: bookmarks.length,
        skippedBookmarks: totalBookmarks - bookmarks.length,
        groupCount: groups.length,
        looseBookmarkCount: bookmarks.filter((item) => item.folderPath.length === 0).length,
        batchCount: Math.ceil(bookmarks.length / 200)
      }
    };
  }

  function importBatchIdempotencyKey(importSessionId, batchIndex) {
    const safeSessionId = String(importSessionId || "")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 100);
    if (!safeSessionId) throw new Error("缺少导入会话 ID");
    return `chrome-import-${safeSessionId}-${Number(batchIndex)}`;
  }

  function createBookmarkImportTask(plan, options) {
    if (!plan?.bookmarks?.length) throw new Error("所选范围没有可导入的 HTTP(S) 书签");
    if (plan.groups.length > 100) throw new Error("一次最多导入 100 个书签文件夹，请改选较小的子树");
    const importSessionId = String(options?.importSessionId || "");
    const now = Number(options?.now) || Date.now();
    const batches = [];
    for (let start = 0, index = 0; start < plan.bookmarks.length; start += 200, index += 1) {
      batches.push({
        index,
        start,
        end: Math.min(start + 200, plan.bookmarks.length),
        idempotencyKey: importBatchIdempotencyKey(importSessionId, index),
        status: "pending",
        attempts: 0,
        result: null,
        lastError: ""
      });
    }
    return {
      version: 1,
      importSessionId,
      status: "ready",
      sourceRootId: plan.selectedRootId,
      sourceLabel: String(options?.sourceLabel || "全部 Chrome 书签"),
      defaultGroupId: normalizeGroupId(options?.defaultGroupId || plan.defaultGroupId),
      createdAt: now,
      updatedAt: now,
      nextRetryAt: null,
      lastError: "",
      preview: { ...plan.preview, batchCount: batches.length },
      manifest: {
        groups: plan.groups,
        bookmarks: plan.bookmarks
      },
      batches,
      completedBatchIndexes: [],
      summary: { total: plan.bookmarks.length, created: 0, duplicate: 0, invalid: 0, failed: 0 }
    };
  }

  function buildBookmarkImportBatchPayload(task, batchIndex) {
    const batch = task?.batches?.[batchIndex];
    if (!batch) throw new Error("导入批次不存在");
    const items = task.manifest.bookmarks.slice(batch.start, batch.end).map((bookmark) => ({
      clientId: bookmark.sourceId,
      url: bookmark.url,
      title: bookmark.title,
      ...(bookmark.folderPath?.length ? { folderPath: bookmark.folderPath } : {})
    }));
    return {
      source: "chrome_extension",
      importSessionId: task.importSessionId,
      defaultGroupId: task.defaultGroupId,
      items
    };
  }

  function summarizeImportResponse(body, expectedTotal) {
    const source = body?.summary || {};
    const count = (key) => {
      if (Number.isFinite(Number(source[key]))) return Math.max(0, Number(source[key]));
      return Array.isArray(body?.results)
        ? body.results.filter((item) => item?.status === key).length
        : 0;
    };
    return {
      total: Number.isFinite(Number(source.total)) ? Number(source.total) : Number(expectedTotal) || 0,
      created: count("created"),
      duplicate: count("duplicate"),
      invalid: count("invalid"),
      failed: count("failed")
    };
  }

  function responseError(body, fallback = "请求失败") {
    const candidate = body?.error?.message ?? body?.message ?? body?.error;
    return typeof candidate === "string" && candidate.trim()
      ? candidate.trim().slice(0, 300)
      : fallback;
  }

  return Object.freeze({
    DEFAULT_SETTINGS,
    buildPermissionOrigin,
    calculateBackoffMs,
    canonicalizeUrl,
    buildBookmarkImportBatchPayload,
    buildBookmarkImportPlan,
    createBookmarkImportTask,
    endpoint,
    extractGroups,
    importBatchIdempotencyKey,
    isPermissionsApiCallable,
    isSafari,
    canRequestPermissions,
    hasPermissionsApi,
    shouldUseHostPermissions,
    safePermissionsContains,
    safePermissionsRequest,
    safePermissionsRemove,
    withTimeout,
    isSavableUrl,
    listBookmarkSubtrees,
    mergeSettings,
    normalizeApiBaseUrl,
    normalizeGroupId,
    responseError,
    summarizeImportResponse
  });
});
