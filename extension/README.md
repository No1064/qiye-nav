# 栖页 Chrome 扩展

一个无构建步骤、零运行时依赖的 Chrome Manifest V3 扩展，用于把网页保存到 Nav Ingest。

## 功能

- 工具栏弹窗保存当前网页，可编辑标题和选择分组。
- 页面或链接右键保存。
- 快捷键保存：macOS 默认 `Command+Shift+S`，其他平台默认 `Alt+Shift+S`。
- 可选监听 `chrome.bookmarks.onCreated`，将 Chrome 新建书签同步到默认分组。
- 在设置页显式授权后预览并导入现有 Chrome 书签，可选择全部书签或一个文件夹子树。
- 日常收藏与无文件夹书签的默认目标均使用分组名称下拉选择；扩展内部仍保存稳定分组 ID。
- 导入预览中的“进入默认组”和“跳过非网页”可展开查看标题、地址、Chrome 来源位置与跳过原因，每次增量显示 50 条。
- 批量导入按最多 200 条拆批，清单、完成批次和逐项结果保存在本地；设置页关闭、断网或 Service Worker 重启后可续传。
- 网络失败、超时、`408`、`429` 或服务端 `5xx` 时写入本地队列，并通过 `chrome.alarms` 指数退避重试。
- 每次收藏创建一个 `Idempotency-Key`；同一队列项的所有重试复用该键。
- 跟随系统浅色 / 深色主题，支持键盘焦点和减少动态效果偏好。
- 可选把浏览器新标签页变成 Graphite Desk 导航桌面（默认关闭）：显示搜索、6 个快捷入口、三列分组链接、两级分类导航，以及时间、月历、家庭服务、目录健康、本地备忘和最近访问；点击记录与备忘只保存在当前浏览器。

Chrome 没有“点击已有书签”的事件，因此扩展不能可靠监听打开已有书签；这里实现的是“新建书签后自动同步”。

扩展绝不会自动扫描现有书签。只有用户在设置页点击“授权并读取”或“确认并开始导入”时，才会调用 `chrome.bookmarks.getTree()`；读取预览不会上传数据。

## 本地安装

1. 打开 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本 `extension/` 目录。
5. 打开扩展设置，填写 Nav Ingest API 地址和设备令牌，连接后从名称下拉中选择默认分组，然后保存并授权。
6. 如需迁移现有书签，进入“导入 Chrome 书签”，点击授权读取、选择范围和默认分组，核对预览后明确确认。
7. 如需接管新标签页，在扩展设置的“新标签页”分区打开开关并保存；关闭开关后新标签页恢复 Chrome 默认行为。

扩展没有打包步骤。修改文件后，在 `chrome://extensions` 中点击扩展卡片上的刷新按钮即可。

## 新标签页

默认不接管。在设置页开启“接管新标签页”后，浏览器每个新标签页都会显示栖页仪表盘：

- 顶部为品牌、问候、连接状态与扩展设置入口；`⌘K` 或 `/` 聚焦搜索框。
- 常用最多 6 项，按当前浏览器内的点击次数排序；没有点击记录时回退为第一个非空分组的前 6 项。
- 最近访问最多 6 项，只记录从这个新标签页打开的网址。
- 左侧仅保留全部网址、可展开的两级分类导航和管理入口，中部网址分组在宽屏下每行显示 3 项。
- 主题支持自动、明亮、暗色三态；自动模式跟随系统变化，选择会保存在当前浏览器。
- Web `/` 通过运行时适配器复用同一套新标签页 UI，不再单独维护另一套首页模板和样式。
- 桌面端左侧目录、中部内容与右侧组件独立滚动，滚动条仅在滚动、悬停或键盘聚焦时出现；移动端使用自然页面滚动。
- 右侧显示本地时间、月历、家庭服务快捷入口、目录健康和本机备忘；家庭服务从家庭服务、NAS、自托管或媒体类分组派生，只标记“未检测”，不申请天气或定位权限。
- 全部点击记录与偏好只写入 `chrome.storage.local`，不申请浏览历史权限；右上角 ⚙ 中可关闭记录、隐藏常用/最近或清空数据。
- 离线时展示最近一次成功抓取的目录快照，并标注连接状态。

关闭开关并保存后，新标签页会尝试回到 Chrome 默认新标签页；若浏览器不允许（极少见），会显示一个静态说明页而不会循环。

## API 约定

扩展调用以下接口：

```text
GET  {API_BASE_URL}/api/v1/groups
POST {API_BASE_URL}/api/v1/bookmarks
POST {API_BASE_URL}/api/v1/bookmarks/batch
```

保存请求示例：

```json
{
  "url": "https://example.com/article",
  "title": "Example",
  "groupId": "inbox",
  "source": "chrome_extension",
  "trigger": "toolbar"
}
```

新建 Chrome 书签还会携带 `chromeBookmarkId`，`trigger` 为 `chrome_bookmark_created`。请求头包括：

```text
Authorization: Bearer <设备令牌>
Idempotency-Key: <本次收藏的稳定幂等键>
Content-Type: application/json
```

`200`、`201`、`202` 视为成功；`409` 视为服务端已存在的幂等成功。网络错误和可重试 HTTP 状态进入队列，明确的 `4xx` 会直接反馈给用户。

`GET /api/v1/groups` 可返回以下任一结构：

```json
[{ "id": "inbox", "name": "收件箱" }]
```

```json
{ "groups": [{ "id": "inbox", "name": "收件箱" }] }
```

也兼容以 `data` 包装的数组，以及 `slug` / `title` 字段。

### 现有书签批量导入

每批最多 200 条，请求示例：

```json
{
  "source": "chrome_extension",
  "importSessionId": "2d5d5a1d-7eb3-4dc0-98aa-bbd20177e109",
  "defaultGroupId": "inbox",
  "items": [
    {
      "clientId": "186",
      "url": "https://developer.mozilla.org/",
      "title": "MDN Web Docs",
      "folderPath": ["工作", "开发资料"]
    },
    {
      "clientId": "187",
      "url": "https://example.com/",
      "title": "Example"
    }
  ]
}
```

`folderPath` 只包含用户创建的文件夹，不包含“书签栏”“其他书签”等 Chrome 系统根目录；没有 `folderPath` 的项目进入 `defaultGroupId`。服务端把 Chrome 目录映射为最多两级：第一段作为父分组，其余段以完整路径合并为子分组，因此深层目录和嵌套同名目录仍可消歧。

每批发送稳定的 `Idempotency-Key: chrome-import-<importSessionId>-<batchIndex>`。服务端响应：

```json
{
  "summary": { "total": 2, "created": 1, "duplicate": 1, "invalid": 0, "failed": 0 },
  "results": [
    { "index": 0, "status": "created", "groupId": "dev", "itemId": "..." },
    { "index": 1, "status": "duplicate", "groupId": "inbox", "itemId": "..." }
  ]
}
```

导入任务写入 `storage.local` 的 `navBookmarkImportTask`：包含 `importSessionId`、源文件夹清单、书签清单、批次边界、稳定幂等键、已完成批次与服务端结果。失败批次保持待处理状态并使用 `chrome.alarms` 退避重试；设置页重新打开后可查看进度、手动继续或取消。取消不会回滚服务端已经完成的批次。

## 权限设计

基础权限只有：

- `activeTab`：在用户点击扩展、使用快捷键或右键菜单时读取当前页。
- `storage`：将设置、设备令牌与离线队列保存在 `storage.local`。
- `contextMenus`：注册页面和链接右键菜单。
- `alarms`：Service Worker 休眠后仍能唤醒重试队列。

`bookmarks` 是可选权限，仅在用户开启自动同步，或在导入区点击“授权并读取”时申请。关闭自动同步并保存设置会移除该权限；以后再次导入时可以重新授权。API host 也是可选权限；Manifest 声明 HTTP(S) 的可申请范围，但设置页只向 Chrome 请求用户填写地址的具体 origin，例如 `https://nav.example.com/*`。扩展不申请 `<all_urls>`、`tabs` 或内容脚本权限。

令牌只写入 `chrome.storage.local`，不会使用 `storage.sync`。建议服务端签发可撤销、仅含 `bookmarks:write` 和 `groups:read` scope 的设备令牌。

## 验证

需要 Node.js 18 或更高版本：

```bash
cd extension
npm test
```

测试会覆盖 URL / origin 规范化、系统根目录排除、子树与嵌套路径、200 条边界、稳定幂等键、权限拒绝，以及断网后由新 Service Worker 续传；静态校验会检查 Manifest V3、最小权限、CSP 兼容、文件引用和 JavaScript 语法。

## 手工验收建议

1. 保存一个普通网页，确认请求体、分组与幂等键正确。
2. 分别从工具栏、页面右键、链接右键和快捷键保存。
3. 关闭 Nav Ingest 后保存，确认扩展徽标显示队列数量；恢复服务并在设置页点击“立即重试”。
4. 开启新书签同步，在 Chrome 新建书签并确认收到 `chrome_bookmark_created` 请求。
5. 关闭新书签同步，确认 `chrome://extensions` 中的书签权限已移除。
6. 导入一个超过 200 条、包含嵌套同名文件夹、系统根散落书签和非 HTTP(S) 项目的书签树；展开“进入默认组”和“跳过非网页”核对来源、地址与原因。
7. 在第二批上传时关闭服务或设置页，恢复后确认只续传未完成批次，且 `Idempotency-Key` 不变。
8. 导入过程中点击取消，确认后续批次停止；完成或取消后可开始新任务。
9. 开启“接管新标签页”后新建标签页，确认出现栖页仪表盘、常用与最近访问随点击变化；关闭开关并保存后，新标签页回到 Chrome 默认页（若浏览器不允许会显示静态说明页，不会循环）；右上角 ⚙ 中关闭记录后点击不再改变常用排序，清空后两条列表立即为空。
