import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const port = Number(process.env.MANAGE_PREVIEW_PORT || 4178);
const sessionCookie = "qiye_admin=preview-session";
const csrfToken = "preview-csrf-token";
let aiConfig = {
  configured: true,
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  hasApiKey: true
};
const aiJob = {
  id: "preview-ai-job",
  status: "completed",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  scope: { type: "all" },
  fields: ["title", "groupId", "description", "tags"],
  allowNewGroups: true,
  groupStrategy: "reorganize",
  groupingOptions: { targetGroupCount: 4, minGroupSize: 5, maxGroupSize: 40 },
  appliedAt: new Date().toISOString(),
  appliedCount: 1,
  phase: "review",
  progress: { total: 5, processed: 5, succeeded: 5, failed: 0 },
  failures: [],
  groupPlan: {
    summary: "按内容主题重建边界，并保留仍然准确的基础分组",
    targetGroupCount: 4,
    retireGroupIds: ["0"],
    groups: [{
      id: "proposal-company",
      name: "OpenAI",
      description: "公司与产品集合",
      sourceGroupIds: ["0"],
      reason: "同一公司下包含多个产品",
      confidence: 0.93,
      itemCount: 0
    }, {
      id: "proposal-1",
      parentPlanGroupId: "proposal-company",
      name: "ChatGPT",
      description: "对话产品与相关资源",
      sourceGroupIds: ["0"],
      reason: "独立项目适合作为二级分组",
      confidence: 0.93,
      itemCount: 1
    }]
  },
  decisionStats: { total: 20, changed: 2, kept: 18 },
  responseLogs: [],
  suggestions: [{
    id: "suggestion-1",
    groupId: "0",
    itemId: "0",
    field: "description",
    currentValue: "研究与产品入口",
    suggestedValue: "AI 研究、产品与开发者资源",
    reason: "说明更具体",
    confidence: 0.91,
    status: "applied",
    appliedAt: new Date().toISOString(),
    createsGroup: false
  }, {
    id: "suggestion-2",
    groupId: "0",
    itemId: "0",
    field: "groupId",
    currentValue: "0",
    suggestedValue: "AI 工具",
    reason: "AI 产品集中后更容易查找",
    confidence: 0.93,
    status: "pending",
    createsGroup: true,
    planGroupId: "proposal-1"
  }]
};
const aiLogs = [{
  sequence: 1,
  at: new Date().toISOString(),
  phase: "group_planning",
  batch: 1,
  attempt: 1,
  itemCount: 5,
  provider: "deepseek",
  model: "deepseek-v4-flash",
  durationMs: 754,
  status: "success",
  finishReason: "stop",
  usage: { promptTokens: 612, completionTokens: 118, totalTokens: 730 },
  content: JSON.stringify({ groups: [{ name: "AI 工具", description: "生成式 AI 产品与开发资源", reason: "用途明确", confidence: 0.93 }] })
}, {
  sequence: 2,
  at: new Date().toISOString(),
  phase: "item_analysis",
  batch: 1,
  attempt: 1,
  itemCount: 5,
  provider: "deepseek",
  model: "deepseek-v4-flash",
  durationMs: 986,
  status: "success",
  finishReason: "stop",
  usage: { totalTokens: 1218 },
  content: JSON.stringify({ items: [{ itemId: "0", decisions: { title: { action: "keep", reason: "标题准确", confidence: 0.98 } } }] })
}];
const catalog = {
  version: "preview-v1",
  groups: [
    {
      id: "4",
      name: "Mozilla",
      itemCount: 0,
      items: []
    },
    {
      id: "0",
      name: "常用",
      itemCount: 2,
      items: [
        {
          id: "0",
          title: "OpenAI",
          url: "https://openai.com",
          description: "研究与产品入口",
          icon: "favicon",
          tags: ["AI", "常用"]
        },
        {
          id: "1",
          title: "GitHub",
          url: "https://github.com",
          description: "代码仓库与协作",
          icon: "favicon",
          tags: ["开发"]
        }
      ]
    },
    {
      id: "1",
      name: "NAS 服务",
      itemCount: 2,
      items: [
        {
          id: "0",
          title: "家庭相册",
          url: "https://photos.home.example.com",
          localUrl: "http://192.168.1.20:5000",
          description: "照片备份与家庭共享",
          icon: "hl-synology-photos",
          tags: ["家庭服务"]
        },
        {
          id: "1",
          title: "影音中心",
          url: "https://media.home.example.com",
          localUrl: "http://192.168.1.20:8096",
          description: "电影与音乐媒体库",
          icon: "generative"
        }
      ]
    },
    { id: "2", parentId: "4", name: "Web 平台", itemCount: 1, items: [{ id: "preview-mdn", title: "MDN", url: "https://developer.mozilla.org", icon: "favicon" }] },
    { id: "3", name: "收件箱", itemCount: 0, items: [] }
  ]
};

const healthJob = {
  id: "preview-health", status: "completed", includeRemote: false,
  createdAt: new Date().toISOString(), scope: { type: "all" },
  findings: [
    { id: "empty-inbox", kind: "empty_group", groupId: "3", message: "空分组：收件箱", items: [] },
    { id: "missing-mdn", kind: "missing_metadata", message: "缺少介绍", items: [{ itemId: "preview-mdn", groupId: "2", groupName: "Web 平台", title: "MDN", url: "https://developer.mozilla.org", icon: "favicon" }] }
  ], progress: { total: 5, processed: 5 }, changeSets: []
};

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function hasSession(request) {
  return String(request.headers.cookie || "")
    .split(";")
    .map((entry) => entry.trim())
    .includes(sessionCookie);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://preview.local");
  if (url.pathname === "/api/v1/admin/auth/login" && request.method === "POST") {
    const credentials = await readJson(request).catch(() => ({}));
    if (!credentials.username || !credentials.password) {
      sendJson(response, 401, { error: { code: "admin_unauthorized", message: "用户名或密码不正确" } });
      return;
    }
    sendJson(response, 200, {
      authenticated: true,
      username: credentials.username,
      csrfToken,
      expiresAt: new Date(Date.now() + 43_200_000).toISOString()
    }, { "set-cookie": `${sessionCookie}; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Max-Age=43200` });
    return;
  }
  if (url.pathname === "/api/v1/admin/auth/session" && request.method === "GET") {
    if (!hasSession(request)) {
      sendJson(response, 401, { error: { code: "admin_unauthorized", message: "请先登录" } });
      return;
    }
    sendJson(response, 200, {
      authenticated: true,
      username: "preview-admin",
      csrfToken,
      expiresAt: new Date(Date.now() + 43_200_000).toISOString()
    });
    return;
  }
  if (url.pathname === "/api/v1/admin/auth/logout" && request.method === "POST") {
    if (!hasSession(request)) {
      sendJson(response, 401, { error: { code: "admin_unauthorized", message: "请先登录" } });
      return;
    }
    if (request.headers["x-csrf-token"] !== csrfToken) {
      sendJson(response, 403, { error: { code: "csrf_invalid", message: "CSRF 校验失败" } });
      return;
    }
    response.writeHead(204, {
      "set-cookie": "qiye_admin=; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Max-Age=0"
    });
    response.end();
    return;
  }
  if (url.pathname.startsWith("/api/v1/admin/") && !hasSession(request)) {
    sendJson(response, 401, { error: { code: "admin_unauthorized", message: "请先登录" } });
    return;
  }
  if (url.pathname.startsWith("/api/v1/admin/") && !["GET", "HEAD"].includes(request.method || "GET")
      && request.headers["x-csrf-token"] !== csrfToken) {
    sendJson(response, 403, { error: { code: "csrf_invalid", message: "CSRF 校验失败" } });
    return;
  }
  if (url.pathname === "/api/v1/admin/health/jobs") { sendJson(response, 200, { jobs: [healthJob] }); return; }
  if (url.pathname === "/api/v1/admin/health/jobs/preview-health") { sendJson(response, 200, healthJob); return; }
  if (url.pathname === "/api/v1/admin/ai/config" && request.method === "GET") {
    sendJson(response, 200, aiConfig);
    return;
  }
  if (url.pathname === "/api/v1/admin/ai/config" && request.method === "PATCH") {
    const next = await readJson(request).catch(() => ({}));
    aiConfig = { ...aiConfig, ...next, configured: true, hasApiKey: Boolean(next.apiKey || aiConfig.hasApiKey) };
    delete aiConfig.apiKey;
    sendJson(response, 200, aiConfig);
    return;
  }
  if (url.pathname === "/api/v1/admin/ai/config/test" && request.method === "POST") {
    sendJson(response, 200, { ok: true, model: aiConfig.model, latencyMs: 286 });
    return;
  }
  if (url.pathname === "/api/v1/admin/ai/jobs" && request.method === "GET") {
    sendJson(response, 200, { jobs: [{
      id: aiJob.id, status: aiJob.status, createdAt: aiJob.createdAt, updatedAt: aiJob.updatedAt,
      scope: aiJob.scope, fields: aiJob.fields, groupStrategy: aiJob.groupStrategy, phase: aiJob.phase,
      groupingOptions: aiJob.groupingOptions,
      progress: aiJob.progress, failureCount: 0, suggestionCount: 2, keptCount: 18,
      proposedGroupCount: 1, model: "deepseek-v4-flash"
    }] });
    return;
  }
  if (url.pathname === "/api/v1/admin/ai/jobs" && request.method === "POST") {
    const input = await readJson(request).catch(() => ({}));
    sendJson(response, 202, { ...aiJob, ...input });
    return;
  }
  if (url.pathname === "/api/v1/admin/ai/jobs/preview-ai-job/apply" && request.method === "POST") {
    const input = await readJson(request).catch(() => ({}));
    sendJson(response, 200, { catalog, applied: input.suggestionIds?.length || 1 });
    return;
  }
  if (url.pathname === "/api/v1/admin/ai/jobs/preview-ai-job/retry" && request.method === "POST") {
    sendJson(response, 202, aiJob);
    return;
  }
  if (url.pathname === "/api/v1/admin/ai/jobs/preview-ai-job" && request.method === "DELETE") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/api/v1/admin/ai/jobs/preview-ai-job" && request.method === "GET") {
    sendJson(response, 200, aiJob);
    return;
  }
  if (url.pathname === "/api/v1/admin/ai/jobs/preview-ai-job/logs" && request.method === "GET") {
    const after = Number(url.searchParams.get("after") || 0);
    sendJson(response, 200, { logs: aiLogs.filter((entry) => entry.sequence > after), nextSequence: 2 });
    return;
  }
  if (url.pathname === "/api/v1/admin/catalog") {
    sendJson(response, 200, catalog);
    return;
  }
  if (url.pathname === "/api/v1/admin/metadata/preview") {
    sendJson(response, 200, { title: "示例网站", description: "自动读取的网站介绍", icon: "https://example.com/favicon.ico" });
    return;
  }
  if (url.pathname.startsWith("/api/v1/admin/")) {
    sendJson(response, 200, catalog);
    return;
  }

  const relative = url.pathname === "/manage/" || url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/manage\//, "");
  const file = resolve(root, relative);
  if (!file.startsWith(root)) {
    response.writeHead(400);
    response.end();
    return;
  }
  try {
    const content = await readFile(file);
    response.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Manage preview: http://127.0.0.1:${port}/manage/`);
});
