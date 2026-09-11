import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["index.html", "newtab.css", "newtab-theme.js", "newtab-runtime.js", "shared.js", "newtab-core.js", "newtab.js"];
for (const file of files) assert.ok(existsSync(join(root, file)), `缺少同步文件：${file}`);

const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "newtab.css"), "utf8");
const runtime = readFileSync(join(root, "newtab-runtime.js"), "utf8");
const app = readFileSync(join(root, "newtab.js"), "utf8");
const theme = readFileSync(join(root, "newtab-theme.js"), "utf8");

assert.match(html, /id="theme-select"[\s\S]*value="auto"[\s\S]*value="light"[\s\S]*value="dark"/, "必须提供自动、明亮、暗色主题");
assert.match(html, /id="all-sites"/, "左栏必须提供全部网址入口");
assert.match(html, /id="catalog-groups"[^>]*scroll-region/, "分组目录必须是独立滚动模块");
assert.match(html, /class="main-column scroll-region"/, "中央内容必须是独立滚动模块");
assert.match(html, /class="widget-rail scroll-region"/, "组件栏必须是独立滚动模块");
assert.doesNotMatch(html, /layout-switch|目录状态|data-govern=/, "不得保留导航首页按钮或目录状态模块");
assert.match(css, /:root\[data-theme="light"\]/, "必须提供明亮主题 token");
assert.match(css, /body\s*\{[^}]*overflow:\s*hidden/s, "桌面端页面整体不得滚动");
assert.match(css, /\.scroll-region\.is-scrolling/, "滚动时必须显示模块滚动条");
const siteIconRule = css.match(/\.site-icon\s*\{([^}]*)\}/)?.[1] || "";
assert.doesNotMatch(siteIconRule, /\bborder\s*:/, "品牌 Logo 外层不得添加自定义边框");
assert.doesNotMatch(siteIconRule, /\bbackground\s*:/, "品牌 Logo 外层不得添加自定义底色");
assert.match(css, /@media \(max-width: 840px\)[\s\S]*overflow-y:\s*auto/, "移动端必须恢复自然页面滚动");
assert.match(runtime, /apiBaseUrl:\s*location\.origin/, "Web 适配器必须使用同源 API");
assert.match(runtime, /localStorage\.getItem/, "Web 适配器必须提供本地偏好存储");
assert.doesNotMatch(app, /\bchrome\./, "共享渲染代码不得直接调用 Chrome API");
assert.match(theme, /prefers-color-scheme:\s*dark/, "自动主题必须跟随系统偏好");
assert.match(theme, /media\.addEventListener\("change"/, "自动主题必须实时响应系统变化");

for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/gi)) {
  if (/^(?:https?:|data:)/.test(match[1])) assert.fail(`首页不应加载远程资源：${match[1]}`);
  assert.ok(existsSync(join(root, match[1])), `首页引用了不存在的文件：${match[1]}`);
}
assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, "首页不得使用内联脚本");
assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "首页不得使用内联事件处理器");

assert.doesNotMatch(css, /\.scroll-region\s*\{[^}]*\bcontain\s*:/s, "滚动模块不得隔离绘制层，以免裁剪网页注释与扩展覆盖层");
assert.doesNotMatch(css, /\.topbar\s*\{[^}]*backdrop-filter\s*:/s, "顶栏不得创建模糊合成层，以免第三方覆盖层闪烁");

for (const file of ["newtab-theme.js", "newtab-runtime.js", "shared.js", "newtab-core.js", "newtab.js", "service-worker.js"]) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  assert.equal(result.status, 0, `${file} 语法错误：${result.stderr}`);
}

console.log(`validate: ${files.length} 个同步首页文件通过静态校验`);
