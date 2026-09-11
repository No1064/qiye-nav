import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const homeRoot = resolve(root, "../home");
const html = readFileSync(join(root, "index.html"), "utf8");
const appFiles = ["runtime.js", "api.js", "ui.js", "session.js", "catalog.js", "ai-jobs.js", "health.js", "events.js", "app.js"];
const app = appFiles.map((file) => readFileSync(join(root, file), "utf8")).join("\n");
const css = readFileSync(join(root, "styles.css"), "utf8");
const icons = readFileSync(join(root, "icons.svg"), "utf8");

for (const file of ["index.html", "styles.css", "core.js", ...appFiles, "icons.svg"]) {
  assert.ok(existsSync(join(root, file)), `缺少管理页文件：${file}`);
}

const scriptFiles = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/gi)]
  .map((match) => match[1].replace(/^\.\//, ""));
assert.deepEqual(scriptFiles, ["core.js", ...appFiles], "管理页脚本必须按依赖顺序加载，且 app.js 最后启动");

assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "禁止内联脚本");
assert.ok(!/\son[a-z]+\s*=/i.test(html), "禁止内联事件处理器");
assert.ok(!/\sstyle\s*=/i.test(html), "禁止内联样式");
for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/gi)) {
  assert.ok(!/^https?:/i.test(match[1]), `禁止远程页面依赖：${match[1]}`);
  const isRootAsset = match[1].startsWith("/");
  const localPath = match[1].replace(/^\/?(?:\.\/)?/, "");
  const assetRoot = isRootAsset ? homeRoot : root;
  assert.ok(existsSync(join(assetRoot, localPath)), `HTML 引用了不存在的文件：${match[1]}`);
}

for (const id of [
  "login-view", "login-form", "login-username", "login-password", "logout-button",
  "ai-organize-button", "ai-dialog", "ai-provider", "ai-base-url", "ai-model", "ai-api-key",
  "agent-name", "agent-role-prompt", "agent-capability-prompt",
  "ai-setup-view", "ai-job-view", "ai-progress", "ai-failure-details", "ai-failure-list", "ai-suggestion-list", "apply-ai-suggestions",
  "health-button", "health-dialog", "health-single-group", "health-multiple-groups", "health-finding-list",
  "select-filtered-health", "clear-health-selection", "preview-health-actions", "import-file", "import-file-name",
  "global-search", "group-list", "item-list", "item-drawer",
  "group-dialog", "settings-dialog", "confirm-dialog", "loading-state", "empty-state", "error-state", "toast-region"
]) {
  assert.ok(html.includes(`id="${id}"`), `缺少关键界面：${id}`);
}

assert.ok(html.includes('id="item-url"') && /id="item-url"[^>]*required/.test(html), "远程地址必须必填");
assert.ok(/id="login-username"[^>]*autocomplete="username"/.test(html), "用户名必须使用 username 自动填充语义");
assert.ok(/id="login-password"[^>]*autocomplete="current-password"/.test(html), "密码必须使用 current-password 自动填充语义");
assert.ok(!app.includes("sessionStorage"), "管理会话不得写入 sessionStorage");
assert.ok(!app.includes("localStorage"), "管理会话不得写入 localStorage");
assert.ok(!app.includes("Authorization") && !app.includes("Bearer"), "管理请求不得复用扩展 Bearer Token");
assert.ok(!app.includes("aiApiKey.value = config") && !app.includes("config.apiKey"), "AI API Key 不得回显到页面");
assert.ok(app.includes('credentials: "same-origin"'), "管理请求必须携带同源 Cookie");
assert.ok(app.includes('"X-CSRF-Token": state.csrfToken'), "写请求必须携带内存中的 CSRF Token");
assert.ok(app.includes('"If-Match": state.catalog.version'), "写请求必须携带 If-Match");

for (const contract of [
  'authRequest("/login"', 'authRequest("/session"', 'authRequest("/logout"',
  'apiRequest("/ai/config"', 'apiRequest("/ai/config/test"', 'apiRequest("/ai/jobs"',
  'fields: selectedAiFields()', 'groupStrategy: elements.aiGroupStrategy.value',
  'retireGroupIds: state.aiJob.groupPlan?.retireGroupIds || []', 'code === "ai_suggestion_stale"',
  'code === "ai_group_plan_stale"',
  '"/catalog"', '"/metadata/preview"', '"/groups"', '"/items"', '"/order"', '"/settings"',
  'scope: "groups"', 'scope: "items"', "targetGroupId", "moveItemsToGroupId", "deleteItems"
]) {
  assert.ok(app.includes(contract), `缺少 API 契约：${contract}`);
}
assert.ok(app.includes('code === "metadata_access_denied"'), "管理页必须友好解释元数据访问被拒绝");
assert.ok(app.includes("NavManageCore.aiGroupingOptions") && !/\bcore\./.test(app), "管理页必须通过已加载的 NavManageCore 调用分组参数逻辑");
assert.ok(app.includes('entry.status === "applied"') && app.includes('suggestion.appliedAt || fallbackAppliedAt'), "AI 历史必须展示已应用建议及应用时间");
assert.ok(html.includes("建议记录") && css.includes(".ai-status-badge.is-applied"), "AI 历史必须提供清晰的已应用状态样式");
assert.ok(html.includes("留空保留现有 Key"), "AI Key 留空时必须清楚说明保留语义");
assert.ok(app.includes("agentRolePrompt") && app.includes("agentCapabilityPrompt"), "后台必须读写导航助手提示词");
assert.ok(/async function loadAiConfig\(\)[\s\S]*elements\.agentName\.value = config\.agentName/.test(app), "导航助手配置必须在 loadAiConfig 响应内回填");
const openSettingsSource = app.slice(app.indexOf("function openSettingsDialog()"), app.indexOf("async function loadAiConfig()"));
assert.ok(!openSettingsSource.includes("config."), "打开设置弹窗时不得访问未定义的 config");
assert.ok(!app.includes('createIcon("folder", "group-symbol")'), "管理分类树不应重复显示文件夹图标");
assert.ok(html.includes('value="title"') && html.includes('value="groupId"')
  && html.includes('value="description"') && html.includes('value="tags"'), "AI 整理必须支持四类确认字段");
for (const contract of [
  'apiRequest("/health/jobs"', 'createHealthJob(false)', 'createHealthJob(true)', 'body: { includeRemote, scope }', 'health/jobs/${encodeURIComponent(state.healthJob.id)}/${action}',
  'body: { actions }', 'type: "delete_item"', 'type: action, itemId: selectedItemId',
  'bookmarks/export?format=${format}', 'apiRequest("/bookmarks/import/preview"',
  'apiRequest("/bookmarks/import/apply"', 'confirmed: true', 'restore: elements.jsonRestore.checked'
]) {
  assert.ok(app.includes(contract), `缺少健康中心或书签转移契约：${contract}`);
}
assert.ok(app.includes('new Option("暂不处理（默认）", "")'), "健康治理动作必须默认为空");
assert.ok(app.includes("recommendedHealthAction") && app.includes("uniqueHealthActionPayloads"), "健康报告必须将推荐、勾选和去重应用分离");
assert.ok(/id="import-file"[^>]*class="sr-only"/.test(html), "原生文件输入必须使用统一选择按钮代理");

assert.ok(css.includes("@media (max-width: 420px)"), "缺少 390px 级手机布局");
assert.ok(html.includes('class="settings-dialog-body"'), "站点设置必须提供独立滚动正文");
assert.ok(/class="dialog-actions settings-dialog-actions"[\s\S]*id="settings-error"[\s\S]*id="save-settings"/.test(html), "站点设置错误状态和操作必须固定在可见页脚");
assert.ok(/#settings-form\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/.test(css), "站点设置表单必须使用固定标题、滚动正文和固定页脚三行布局");
assert.ok(/\.settings-dialog-body\s*\{[\s\S]*min-height:\s*0;[\s\S]*overflow-y:\s*auto;[\s\S]*overscroll-behavior:\s*contain;[\s\S]*scroll-padding-block:\s*16px;[\s\S]*scrollbar-gutter:\s*stable;/.test(css), "站点设置正文必须支持独立滚动和键盘焦点定位");
assert.ok(/#settings-dialog\s*\{[\s\S]*max-height:\s*calc\(100dvh - 30px\)/.test(css), "站点设置必须限制在桌面视口内");
assert.ok(/@media \(max-width: 420px\)[\s\S]*#settings-dialog\s*\{[\s\S]*width:\s*calc\(100% - 16px\);[\s\S]*max-height:\s*calc\(100dvh - 16px\)/.test(css), "站点设置必须保留 390px 视口安全边距");
assert.ok(css.includes("@media (hover: none), (pointer: coarse)"), "缺少触控设备交互降级");
assert.ok(css.includes(".bulk-actions .button") && css.includes(".ai-job-actions .button")
  && css.includes(".health-job-actions .button"), "390px 布局必须堆叠批量、AI 和健康任务操作");
assert.ok(css.includes("min-height: 44px") && css.includes("overflow-wrap: anywhere"), "触控目标与长 URL 必须在手机端可用");
assert.ok(!css.includes(":has("), "经典管理页样式不应依赖 :has");
assert.ok(!app.includes(".at("), "经典脚本不应依赖 Array.prototype.at");
assert.ok(css.includes("prefers-reduced-motion"), "缺少 reduced motion 支持");
assert.ok(css.includes("prefers-reduced-transparency"), "缺少 reduced transparency 降级");
assert.ok(css.includes("--accent: #2758f5") && css.includes("--accent: #6687ff"), "管理页浅深色必须使用首页 Graphite Desk 主色");
assert.ok(css.includes("font-size: 14px") && css.includes(".group-disclosure"), "管理分类展开标记必须使用 14px 尺寸");
for (const legacyColor of ["#607f32", "#506d29", "#b7d97e", "#c3e48b", "#f2f3ed"]) {
  assert.ok(!css.toLowerCase().includes(legacyColor), `管理页不应残留旧橄榄色：${legacyColor}`);
}
for (const icon of ["plus", "x", "search", "trash", "grip-vertical", "chevron-up", "chevron-down", "folder", "settings"]) {
  assert.ok(icons.includes(`id="icon-${icon}"`), `缺少本地图标：${icon}`);
}

const visibleSources = `${html}\n${app}`;
assert.ok(!/[—–]/.test(visibleSources), "可见文案不得包含破折号字符");

for (const file of ["core.js", ...appFiles]) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  assert.equal(result.status, 0, `${file} 语法错误：${result.stderr}`);
}

console.log("✓ 管理页结构、登录会话、CSRF、API 契约、图标、无内联脚本与响应式静态校验通过");
