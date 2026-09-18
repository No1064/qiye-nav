# 架构说明

本文描述栖页当前的实际结构，用于判断改动应落在哪个模块，以及改动会波及哪些边界。接口清单见 [api.md](api.md)，变量清单见 [configuration.md](configuration.md)。

## 组件与数据流

```text
浏览器 / Chrome 扩展新标签页
        │  同源静态资源 + /api/v1/*
        ▼
     gateway (Caddy)  ──压缩、安全响应头、健康检查──┐
        ▼                                          │
     ingest (Node.js, 端口 3000)  ◀────────────────┘
        │  纯文件持久化，无数据库
        ▼
   ops/data/  (catalog.json · ai-jobs.json · health-jobs.json · backups/ · icon-cache/ …)
```

- `extension/` 是界面唯一源，同时提供 Chrome 新标签页与网页首页（见下文同步规则）。
- `services/ingest/` 是无框架的 Node.js 服务：静态资源、公开目录、扩展采集、管理后台、AI 与健康任务共用一个进程。
- 数据全部是 JSON 文件与本地目录，通过 bind mount 挂在 `ops/data/`，因此备份等于复制目录。

## 请求处理

`server.ts` 读取配置、装配依赖，把 `createApp()` 返回的 `RequestListener` 直接交给 `node:http`。`app.ts` 内部没有路由器抽象：一个闭包按 `if (方法 + 路径正则)` 自上而下匹配，末尾 `.catch()` 把 `HttpError` 映射为状态码、未知错误映射为 500。

横切关注点以函数形式内联，执行顺序即阅读顺序：

| 关注点 | 实现 |
| --- | --- |
| 跨域 | `allowedCorsHeaders()` + `OPTIONS` 预检短路 |
| 管理鉴权 | `adminAuth.requireSession()`；`/api/v1/admin/*` 统一入口拦截 |
| CSRF 与同源 | 非 GET 走 `adminAuth.requireMutation()`（双重提交 token + `Sec-Fetch-Site`/Origin） |
| 乐观并发 | `requestVersion()` 解析 `If-Match`（容忍 Caddy 的 `-gzip` 后缀），`checkedWrite()` 比对目录版本，不符返回 409 `version_conflict` |
| 串行写 | `serialWrite()` 单链 promise，`CatalogStore` 另有独立写队列 |
| 幂等 | `IdempotencyStore` 以 key → 指纹 + 在途 promise 记录，TTL 可配 |
| 请求体 | `readJson()` 限制 1 MiB 且要求 `application/json` |

已抽取到 `src/routes/` 的只有四组：agent 查询、公开接口、管理端 AI、管理端健康与书签导入导出。**其余仍在 `app.ts`**：认证与改密、设置、分组/条目/排序 CRUD、元数据预览、图标代理、以及全部静态资源服务。`app.ts` 近 900 行是当前最主要的技术债，新增路由应优先落到 `src/routes/`。

## 数据层

`CatalogStore` 独占 `catalog.json`。`mutate()` 的顺序是固定的：读取 → 克隆 → 变更 → `normalizeCatalog()` → `backupCurrent()` → `atomicReplace()`。

- **写前备份**：替换前把当前目录复制为 `backups/catalog-<时间>-<uuid>.json`，任何批量变更都可整体回到写入前。
- **原子替换**：写入 `dirname` 下的 `.catalog.json.<pid>.<uuid>.tmp`（`wx` 模式、`0600`）、`fsync` 文件、`rename`、再 `fsync` 目录。进程崩溃不会留下半截目录。
- **版本语义**：目录版本是 `{schemaVersion, settings, groups}` 的 sha256，**不包含**条目内的运行时字段。读取时重新计算并与存储值比对，不一致抛 `CatalogCorruptError`（503）而不是静默修复。

其余持久化各自独立，互不共用文件：

| 文件（默认在 catalog 同级目录） | 归属模块 | 说明 |
| --- | --- | --- |
| `ai-jobs.json` | `AiJobRepository` | AI 任务状态机与批次检查点 |
| `health-jobs.json` | `HealthJobRepository` | 健康扫描任务与检查点 |
| `import-sessions.json` | `ImportSessions` | 扩展分批导入会话，7 天过期 |
| `ai-config.enc.json` | `AiConfigStore` | AES-256-GCM 密文的服务商配置 |
| `admin-credentials.json` | `AdminCredentials` | 后台改密后的哈希，覆盖 `.env` 初值 |
| `icon-cache/` | `IconCache` | 内容寻址目录，7 天 TTL / 单文件 256 KiB / 最多 512 个 |
| `backups/ai-changesets/<id>.json` | `CatalogStore` | 不可变变更集，`wx` 创建，重名即 409 |

## AI 整理流水线

拆分原则是「编排」与「纯逻辑」分离，纯逻辑模块可单测且不碰网络：

- `ai-jobs.ts`：只做编排与队列 worker，不生成提示词、不解析响应。
- `ai-job-state-machine.ts`：纯状态迁移（启动、暂停、继续、取消、完成分析）。
- `ai-job-batch-processor.ts`：动态批量大小、批次检查点、失败分类。
- `ai-job-input.ts` / `ai-job-model.ts`：请求校验 / 整理范围与分组选项选择。
- `ai-job-prompts.ts` / `ai-job-response-parser.ts`：提示词构建 / JSON 转 `AiSuggestion` 与 `AiGroupPlan`。
- `ai-job-application.ts`：应用与回滚时的条目挑选。
- `ai-client.ts`：唯一的供应商 HTTP 出口；`ai-config.ts`：加密的 provider 记录。

改动提示词或响应容错时只应触碰 `ai-job-prompts.ts` 与 `ai-job-response-parser.ts`；需要新整理策略时改 `ai-job-model.ts`。

## 健康检查流水线

与 AI 流水线同构：`health-jobs.ts` 编排限速与 worker，`health-job-repository.ts` 持久化与校验，`health-job-input.ts` 解析请求，`health-scan.ts` 产生结论（`scanCatalogLocally()` 处理重复、空分组、资料缺失；`checkRemoteUrl()` 处理远程探测），`health-governance.ts` 把治理动作翻译成目录操作，`health-summary.ts` 聚合公开摘要，`health-types.ts` 共享类型。**目录的实际写入仍由 `CatalogStore` 执行**，健康模块不直接改文件。

## 界面单一源

`scripts/sync-newtab-home.mjs` 只做一个方向、共 13 个文件的**逐字节复制**：`extension/newtab.html → services/ingest/public/home/index.html`，`newtab.css`、`newtab-theme.js`、`newtab-runtime.js`、`shared.js`、`newtab-core.js`、`newtab.js` 同名复制，再加 `assets/` 下的 brand-mark、favicon 与四个尺寸图标。

因此：

- 不要直接编辑 `public/home/` 中这 13 个文件，改动会被覆盖且在 `--check` 下失败。
- 这不是构建步骤，没有语法转换：`extension/` 里的代码必须在 Web 源下也能优雅降级（例如 `chrome.*` 不可用时的分支）。
- `--check` 逐字节比对，任一不一致即 `exit 1`；`npm run check`、后端 `pretest` 与 `ops/scripts/start.sh` 都会执行它。
- 名单之外的 `public/home/` 文件是 Web 专属，可以自由新增。

## 信任边界

两套凭证不可互换：

- **扩展采集**：`INGEST_TOKEN` 是一个静态共享 Bearer token，`timingSafeEqual` 比对，覆盖所有设备——它不是设备级凭证，也没有单独吊销能力。Token 不能登录后台。
- **管理会话**：`qiye_admin` cookie，`HttpOnly` + `SameSite=Strict` + `Path=/api/v1/admin`，内存会话按 token 的 sha256 索引，空闲 2 小时 / 绝对 12 小时过期，最多 100 个会话；改密即清空全部会话。

`/api/v1/agent/query` 接受同源的后台会话或扩展 token 之一。

**对外发请求的收敛点**：`security.ts` 的 `assertPublicFetchUrl()` 先解析 DNS，任一答案落在私网或保留地址（含 IPv4 十四段 CIDR、IPv6 ULA/multicast、`::ffff:` 映射）即拒绝。元数据抓取（逐跳转重检，favicon 再检一次）、健康远程探测、图标缓存、AI baseUrl 都经过它。`url.ts` 只允许 http(s) 且禁止内嵌凭据。

**图标代理**额外做来源白名单：`allowedIconSource()` 只接受条目自身已声明的图标地址，或 Google favicon、IconHorse、Dashboard Icons 三个具名 Provider 的精确形态；配合 `assertPublicFetchUrl`，私网地址不会被送去第三方。响应头带 `content-security-policy: sandbox`、`nosniff` 与 `cross-origin-resource-policy: cross-origin`。

## 已知取舍

- 公开目录接口不要求登录，能访问服务即可读取书签，这是导航站的默认用法，代价是暴露面见 [SECURITY.md](../SECURITY.md)。
- 单进程 + JSON 文件，换取零依赖部署与可备份性；不支持并发多实例写同一目录。
- `services/ingest/public/start/` 是历史 `/start/` 入口的兼容跳转页，不再是独立界面。
- 界面活动记录、备忘与对话历史只存浏览器本地，服务端不收集。
