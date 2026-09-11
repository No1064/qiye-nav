import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(extensionRoot, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

assert.equal(manifest.manifest_version, 3, "必须使用 Manifest V3");
assert.equal(manifest.background?.service_worker, "background.js", "必须配置 service worker");
assert.ok(manifest.action?.default_popup, "必须配置工具栏弹窗");
assert.ok(manifest.options_page, "必须配置设置页");
assert.equal(manifest.chrome_url_overrides?.newtab, "newtab.html", "新标签页覆盖必须指向 newtab.html");
assert.ok(manifest.commands?.["save-current-tab"], "必须配置保存快捷键");
assert.equal(manifest.host_permissions, undefined, "固定 host_permissions 会扩大权限范围");
assert.ok(manifest.optional_permissions?.includes("bookmarks"), "bookmarks 必须是可选权限");
assert.deepEqual(
  new Set(manifest.permissions),
  new Set(["activeTab", "storage", "contextMenus", "alarms"]),
  "基础权限应保持最小集合"
);
assert.ok(!JSON.stringify(manifest).includes("<all_urls>"), "禁止申请 <all_urls>");

const requiredFiles = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  manifest.chrome_url_overrides.newtab,
  "shared.js",
  "popup.js",
  "popup.css",
  "options.js",
  "options.css",
  "newtab.js",
  "newtab-core.js",
  "newtab.css",
  "newtab-theme.js",
  "newtab-runtime.js"
];
for (const file of requiredFiles) {
  assert.ok(existsSync(join(extensionRoot, file)), `缺少文件：${file}`);
}

for (const htmlFile of [manifest.action.default_popup, manifest.options_page, manifest.chrome_url_overrides.newtab]) {
  const html = readFileSync(join(extensionRoot, htmlFile), "utf8");
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${htmlFile} 含内联脚本`);
  assert.ok(!/\son[a-z]+\s*=/i.test(html), `${htmlFile} 含内联事件处理器`);
  assert.ok(!/\sstyle\s*=/i.test(html), `${htmlFile} 含内联样式`);

  for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/gi)) {
    if (/^(?:https?:|data:)/.test(match[1])) {
      assert.fail(`${htmlFile} 不应加载远程资源：${match[1]}`);
    }
    assert.ok(existsSync(join(extensionRoot, match[1])), `${htmlFile} 引用了不存在的文件：${match[1]}`);
  }
}

for (const jsFile of ["shared.js", "background.js", "popup.js", "options.js", "newtab.js", "newtab-core.js", "newtab-theme.js", "newtab-runtime.js"]) {
  const result = spawnSync(process.execPath, ["--check", join(extensionRoot, jsFile)], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `${jsFile} 语法错误：${result.stderr}`);
}

const background = readFileSync(join(extensionRoot, "background.js"), "utf8");
for (const marker of ["Idempotency-Key", "chrome.bookmarks.onCreated", "chrome.alarms.onAlarm", "contextMenus.onClicked"]) {
  assert.ok(background.includes(marker), `background.js 缺少关键能力：${marker}`);
}

for (const marker of [
  "/api/v1/bookmarks/batch",
  "navBookmarkImportTask",
  "PREVIEW_BOOKMARK_IMPORT",
  "RESUME_BOOKMARK_IMPORT",
  "CANCEL_BOOKMARK_IMPORT",
  "completedBatchIndexes"
]) {
  assert.ok(background.includes(marker), `background.js 缺少批量导入能力：${marker}`);
}

const optionsHtml = readFileSync(join(extensionRoot, manifest.options_page), "utf8");
const popupHtml = readFileSync(join(extensionRoot, manifest.action.default_popup), "utf8");
assert.match(popupHtml, /id="open-home"[^>]*aria-label="打开导航主页"/, "弹窗必须提供可访问的导航主页入口");
const popupJs = readFileSync(join(extensionRoot, "popup.js"), "utf8");
assert.match(popupJs, /normalizeApiBaseUrl\(settings\.apiBaseUrl\)/, "导航主页地址必须基于已归一化的 API 地址");
assert.match(popupJs, /chrome\.tabs\.create\(\{ url: homeUrl \}\)/, "导航主页必须在新标签页打开");
for (const cssFile of ["popup.css", "options.css"]) {
  const css = readFileSync(join(extensionRoot, cssFile), "utf8");
  assert.match(css, /--accent:\s*#2758f5/i, `${cssFile} 浅色主题必须使用首页品牌蓝`);
  assert.match(css, /--accent:\s*#6687ff/i, `${cssFile} 深色主题必须使用首页品牌蓝`);
  assert.match(css, /"SF Pro Text", "SF Pro Display"/, `${cssFile} 必须复用首页字体栈`);
  assert.doesNotMatch(
    css,
    /#(?:087a5b|056348|3ca782|53ba95|57b996|18201d|19211e|111613|0b100e|18362c|18372c)/i,
    `${cssFile} 不得残留旧绿色视觉令牌`
  );
}
for (const id of [
  "bookmark-import",
  "read-bookmarks",
  "import-source",
  "import-default-group",
  "import-loose-detail-toggle",
  "import-skip-detail-toggle",
  "import-detail-panel",
  "load-more-import-detail",
  "import-confirm",
  "start-bookmark-import",
  "resume-bookmark-import",
  "cancel-bookmark-import"
]) {
  assert.ok(optionsHtml.includes(`id="${id}"`), `设置页缺少导入控件：${id}`);
}
assert.match(optionsHtml, /<select id="default-group"/, "收藏默认分组必须使用名称下拉");
assert.match(optionsHtml, /<select id="import-default-group"/, "导入默认分组必须使用名称下拉");
assert.doesNotMatch(optionsHtml, /默认分组 ID/, "界面不应要求用户理解内部的分组 ID");
for (const id of ["new-tab-enabled", "newtab-permission"]) {
  assert.ok(optionsHtml.includes(`id="${id}"`), `设置页缺少新标签页控件：${id}`);
}

const shared = readFileSync(join(extensionRoot, "shared.js"), "utf8");
for (const marker of ["buildBookmarkImportPlan", "createBookmarkImportTask", "start += 200", "folderPath", "newTabEnabled"]) {
  assert.ok(shared.includes(marker), `shared.js 缺少导入规划能力或新标签页设置：${marker}`);
}

const newTabCore = readFileSync(join(extensionRoot, "newtab-core.js"), "utf8");
for (const marker of ["resolveNewTabMode", "sanitizeActivity", "dashboardFrequentItems", "getIconCandidates"]) {
  assert.ok(newTabCore.includes(marker), `newtab-core.js 缺少关键能力：${marker}`);
}

const newTabJs = readFileSync(join(extensionRoot, "newtab.js"), "utf8");
for (const marker of ["QiyeRuntime", "navNewTabActivity", "navNewTabSnapshot", "initializeScrollRegions", "showAllView"]) {
  assert.ok(newTabJs.includes(marker), `newtab.js 缺少新标签页关键能力：${marker}`);
}
assert.doesNotMatch(newTabJs, /\bchrome\./, "共享新标签页渲染代码不得直接依赖 Chrome API");
const newTabRuntime = readFileSync(join(extensionRoot, "newtab-runtime.js"), "utf8");
for (const marker of ["chrome.storage.local", "chrome://newtab", "chrome.tabs.getCurrent", "apiBaseUrl: location.origin", "localStorage.getItem"]) {
  assert.ok(newTabRuntime.includes(marker), `newtab-runtime.js 缺少运行时适配能力：${marker}`);
}

const newTabHtml = readFileSync(join(extensionRoot, manifest.chrome_url_overrides.newtab), "utf8");
for (const id of [
  "catalog-groups", "frequent-list", "catalog-items", "calendar-grid", "family-service-list", "memo-input",
  "widget-dup-count", "recent-list", "offline-status", "settings-dialog", "all-sites", "theme-select"
]) {
  assert.ok(newTabHtml.includes(`id="${id}"`), `Graphite Desk 缺少关键区域：${id}`);
}
assert.doesNotMatch(newTabHtml, /<\/main>\s*<\/main>/, "新标签页不应包含重复的 main 闭合标签");
assert.match(newTabHtml, /<textarea id="memo-input" maxlength="2000"/, "本地备忘必须支持 2000 字符上限");
assert.doesNotMatch(newTabHtml, /layout-switch|目录状态|data-govern=/, "不得保留导航首页按钮或目录状态模块");
assert.doesNotMatch(newTabHtml, /class="sidebar-heading"/, "左栏不应保留分类导航标题行");
assert.match(newTabHtml, /class="all-sites-icon"/, "全部网址必须使用独立集合图标");
for (const id of ["agent-shell", "agent-panel", "agent-form", "agent-open", "agent-input", "agent-messages", "agent-history", "agent-new", "agent-collapse"]) {
  assert.ok(newTabHtml.includes(`id="${id}"`), `导航 Agent 缺少关键区域：${id}`);
}
assert.match(newTabHtml, /id="agent-submit"[^>]*disabled/, "导航 Agent 发送按钮必须初始禁用");
assert.match(newTabHtml, /id="agent-open"[^>]*type="button"[^>]*aria-controls="agent-panel"[^>]*aria-expanded="false"/, "Agent Logo 必须是可访问的独立展开按钮");
for (const marker of ["AGENT_SESSIONS_KEY", "sanitizeAgentSessions", "appendAgentInline", "nav:", "updateAgentSubmit"]) {
  assert.ok(newTabJs.includes(marker), `导航 Agent 缺少安全历史或按钮能力：${marker}`);
}
assert.doesNotMatch(newTabJs, /\.innerHTML\b/, "导航 Agent 不得使用 innerHTML 渲染 Markdown");
assert.match(newTabJs, /agentInput\.addEventListener\("focus", expandAgentPanel\)/, "Agent 输入框聚焦时必须无条件展开面板");
assert.match(newTabJs, /agentOpen\.addEventListener\("click", toggleAgentPanel\)/, "Agent Logo 必须支持点击切换面板");
assert.match(newTabJs, /agentShell\.contains\(event\.target\)/, "Agent 面板必须以完整 shell 作为外部点击边界");
assert.match(newTabJs, /!document\.querySelector\("dialog\[open\]"\)/, "Agent Escape 不得抢占已打开模态框的关闭行为");
assert.match(newTabJs, /if \(!elements\.agentPanel\.hidden\) elements\.agentInput\.focus\(\)/, "Agent 请求结束时不得让已收起面板反弹展开");
const renderAgentConversationSource = newTabJs.match(/function renderAgentConversation\(\)\s*\{([\s\S]*?)\n  \}/)?.[1] || "";
assert.doesNotMatch(renderAgentConversationSource, /expandAgentPanel/, "恢复历史与渲染会话不得自动展开 Agent 面板");
for (const marker of ["agentEmpty", "aria-current", "remainingTagCount", "site-tags", "目标地址"]) {
  assert.ok(newTabJs.includes(marker), `首页缺少 Agent 空状态、历史或卡片元数据能力：${marker}`);
}
assert.match(newTabJs, /now = Number\.isFinite\(now\) \? now : Date\.now\(\)/, "运行时点击记录必须提供默认时间戳");
assert.match(newTabHtml, /assets\/brand-mark\.svg/, "导航页必须使用统一品牌 SVG");

const newTabCss = readFileSync(join(extensionRoot, "newtab.css"), "utf8");
assert.doesNotMatch(newTabCss, /#agent-submit:disabled\s*\{[^}]*cursor:\s*wait/s, "Agent 禁用发送按钮不得显示加载光标");
assert.match(newTabCss, /\.group-disclosure\s*\{[^}]*font-size:\s*14px/s, "分类展开标记必须使用 14px 字号");
assert.match(newTabCss, /\.icon-button\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px/s, "顶栏工具按钮必须使用 40px 点击区域");
assert.match(newTabCss, /\.card-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s, "网址分组必须默认使用三列布局");
assert.match(newTabCss, /\.dock-grid\s*\{[^}]*grid-template-columns:\s*repeat\(6,/s, "快捷入口必须默认使用六列布局");
assert.match(newTabCss, /\.card-grid \.site-card\s*\{[^}]*min-height:\s*100px/s, "网址卡片必须为介绍和标签提供紧凑稳定的高度");
assert.match(newTabCss, /\.site-description\s*\{[^}]*-webkit-line-clamp:\s*2/s, "网址介绍必须限制为两行");
assert.match(newTabCss, /\.dock-grid \.site-description, \.dock-grid \.site-tags\s*\{[^}]*display:\s*none/s, "Quick Access 必须保持紧凑并隐藏介绍与标签");
assert.match(newTabCss, /\.agent-history-delete\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px/s, "历史删除按钮必须保持低侵扰的小点击区");
assert.match(newTabCss, /--accent:\s*#6687ff/i, "深色主题必须使用统一冷蓝强调色");
assert.match(newTabCss, /:root\[data-theme="light"\][\s\S]*--accent:\s*#2758f5/i, "明亮主题必须使用统一品牌蓝强调色");
assert.match(newTabCss, /:root\[data-theme="light"\]/, "Graphite Desk 必须提供明亮主题");
assert.match(newTabCss, /body\s*\{[^}]*overflow:\s*hidden/s, "桌面端页面整体不得滚动");
assert.match(newTabCss, /\.scroll-region\.is-scrolling/, "模块滚动条必须在滚动时出现");
assert.doesNotMatch(newTabCss, /\.scroll-region\s*\{[^}]*\bcontain\s*:/s, "滚动模块不得隔离绘制层，以免裁剪网页注释与扩展覆盖层");
assert.doesNotMatch(newTabCss, /\.topbar\s*\{[^}]*backdrop-filter\s*:/s, "顶栏不得创建模糊合成层，以免第三方覆盖层闪烁");
const siteIconRule = newTabCss.match(/\.site-icon\s*\{([^}]*)\}/)?.[1] || "";
assert.doesNotMatch(siteIconRule, /\bborder\s*:/, "品牌 Logo 外层不得添加自定义边框");
assert.doesNotMatch(siteIconRule, /\bbackground\s*:/, "品牌 Logo 外层不得添加自定义底色");
const newTabTheme = readFileSync(join(extensionRoot, "newtab-theme.js"), "utf8");
for (const marker of ["auto", "light", "dark", "prefers-color-scheme: dark", "media.addEventListener(\"change\""] ) {
  assert.ok(newTabTheme.includes(marker), `newtab-theme.js 缺少三态主题能力：${marker}`);
}
assert.doesNotMatch(newTabJs, /className = "group-toggle"/, "分组展开按钮不得与分类标题分离");
assert.match(newTabJs, /setAttribute\("aria-expanded"/, "一级分类标题必须暴露展开状态");
for (const size of [16, 32, 48, 128]) {
  assert.equal(manifest.icons?.[String(size)], `assets/icon-${size}.png`, `Manifest 缺少 ${size}px 品牌图标`);
}
for (const marker of ["monthCalendar", "navNewTabMemo"]) {
  assert.ok(newTabJs.includes(marker) || newTabCore.includes(marker), `Graphite Desk 缺少关键能力：${marker}`);
}

console.log("✓ Manifest、权限、CSP、文件引用和 JavaScript 语法校验通过");
