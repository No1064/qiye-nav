# 栖页 Web 首页

此目录中的 `index.html`、`newtab.css`、`newtab-theme.js`、`newtab-runtime.js`、`shared.js`、`newtab-core.js` 与 `newtab.js` 是 Chrome 新标签页界面的自动同步产物。

唯一 UI 源位于仓库根目录的 `extension/`。不要直接编辑上述同步文件；修改扩展新标签页后运行：

```bash
node scripts/sync-newtab-home.mjs
```

`ops/scripts/start.sh` 会在构建 Docker 镜像前自动同步。Web 与扩展的环境差异统一封装在 `newtab-runtime.js`：扩展使用 `chrome.storage.local` 和扩展设置页，Web 使用 `localStorage`、同源 API 与 `/manage/`。

`service-worker.js` 仅用于清理旧版独立首页遗留的 PWA 缓存与注册，不属于当前 UI 源。
