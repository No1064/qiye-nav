# 配置参考

`services/ingest/src/config.ts` 是服务侧配置的唯一入口，`ops/docker-compose.yml` 负责把 Compose 变量注入容器。部署步骤见 [deployment.md](deployment.md)。

密钥类变量只应存在于 `ops/.env`。该文件已被忽略，不要提交、打印或分享。

## 必填变量

`loadAppConfig()` 对以下四项在缺失或为空时直接抛错，**服务拒绝启动**（没有默认密码、没有默认 token）：

| 变量 | 约束 | 说明 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 最长 200 字符 | 后台登录名 |
| `ADMIN_PASSWORD_HASH` | 必须能被 `parsePasswordHash()` 解析为 `scrypt$…` | 初始哈希；后台改密后由 `admin-credentials.json` 覆盖 |
| `INGEST_TOKEN` | 非空字符串 | 扩展采集用的共享 Bearer token |
| `AI_CONFIG_ENCRYPTION_KEY` | 64 位十六进制，或 base64 且**解码后恰好 32 字节** | 加密 AI 服务商配置与 API Key |

`ops/scripts/set-admin-password.sh` 会一次性生成后两项并写入 `ops/.env`；`start.sh` 只在值为占位符时补齐，已存在的有效密钥不会被重新生成。

**丢失 `AI_CONFIG_ENCRYPTION_KEY` 的后果不可逆**：`ai-config.enc.json` 将无法解密，接口返回 500 `ai_config_corrupt`，只能重新填写服务商配置。数据目录备份不包含它。

## 服务级可选变量

默认值来自 `config.ts`，范围为代码强制。

| 变量 | 默认 | 范围 | 影响 |
| --- | --- | --- | --- |
| `PORT` | `3000` | 1–65535 | 容器内监听端口，由 Caddy 对外转发 |
| `ALLOW_LOCAL_URLS` | **`true`** | 布尔 | 允许保存与展示局域网/NAS 私有地址。设为 `false` 后 `localUrl` 相关写入被拒 |
| `DEFAULT_GROUP` | `收件箱` | 任意 | 未分组条目的落点 |
| `CORS_ALLOWED_ORIGINS` | 空 | 逗号分隔的 origin 或 `*` | **留空即禁止网站跨域读取**：带 `Origin` 且不在名单内的 `OPTIONS` 返回 403。扩展 origin（`chrome-extension://`、`moz-extension://`）始终放行，因为浏览器不会让网页伪造自己的 Origin，而公开目录本来就能被无 Origin 的请求读取——Safari/WebKit 对扩展后台 fetch 强制 CORS（与 host 权限无关），这条规则正是新装实例在 Safari 上能连通的原因。要让另一个网站读目录才需要显式列 origin；`*` 等于向任意网站开放目录，只在服务绑定 `127.0.0.1` 且目录不含隐私时才合适 |
| `ADMIN_COOKIE_SECURE` | `false` | 布尔 | HTTPS 部署必须设为 `true`，否则会话 cookie 会经明文 HTTP 发送 |
| `FETCH_TIMEOUT_MS` | `5000` | 100–30000 | 抓取网页元数据的超时 |
| `FETCH_MAX_BYTES` | `1048576` | 1024–5242880 | 元数据抓取响应体上限 |
| `IDEMPOTENCY_TTL_SECONDS` | `86400` | 60–604800 | 批量导入幂等键的保留时长 |

## 路径变量

留空时全部落在 `CATALOG_PATH` 的同级目录，也就是容器内的 `/app/data/`（对应宿主机 `ops/data/`）。

| 变量 | 默认 | 内容 |
| --- | --- | --- |
| `CATALOG_PATH` | `/app/data/catalog.json` | 目录主文件 |
| `CATALOG_BACKUP_DIR` | `dirname(CATALOG_PATH)/backups` | 写前备份与 AI 变更集 |
| `CATALOG_INIT_PATH` | 未设置 | 首次启动的迁移输入；未设置则建空目录。Compose 默认指向 `conf.example.yml`，存在个人 `conf.yml` 时使用它 |
| `AI_CONFIG_PATH` | `…/ai-config.enc.json` | 加密后的 AI 配置 |
| `AI_JOBS_PATH` | `…/ai-jobs.json` | AI 任务与检查点 |
| `HEALTH_JOBS_PATH` | `…/health-jobs.json` | 健康任务与检查点 |
| `IMPORT_SESSIONS_PATH` | `…/import-sessions.json` | 扩展分批导入会话 |

`admin-credentials.json` 与 `icon-cache/` 同样按 `CATALOG_PATH` 定位，没有独立开关。

## 只在 Compose 层生效

这些变量由 `ops/docker-compose.yml` 插值，**不会被 Node 代码读取**：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `personal-nav` | Compose 项目名 |
| `QIYE_IMAGE` | `qiye:0.2.0` | 应用镜像；使用预构建或离线包时改为对应标签 |
| `CADDY_IMAGE` | `caddy:2.10.2-alpine` | 网关镜像 |
| `BIND_ADDRESS` | `127.0.0.1` | 对外监听地址。改成 `0.0.0.0` 或局域网地址即扩大暴露面 |
| `GATEWAY_PORT` | `8080` | 网页与 API 的统一入口 |
| `INGEST_PORT` | `8787` | 直连应用端口（绕过网关，供扩展或排障） |
| `NAV_UID` / `NAV_GID` | `1000` | 容器内运行身份；`start.sh` 会导出宿主机用户 ID，并拒绝以 root 运行 |

`LOG_LEVEL` 目前出现在 `ops/.env.example` 与 compose 的环境注入里，但**没有任何组件读取它**，日志仍是无级别的 `console` 输出。调整它不会改变任何行为。

## 脚本与开发用变量

| 变量 | 出现位置 | 用途 |
| --- | --- | --- |
| `MIGRATION_SOURCE` / `CHECK_SOURCE_COUNTS` | `ops/scripts/migrate.sh` | 迁移输入与条目数核对 |
| `MANAGE_PREVIEW_PORT` | `public/manage/tests/mock-server.mjs` | 管理页测试用的本地预览端口，默认 4178 |
| `NODE_ENV` | `services/ingest/Dockerfile` | 构建阶段 |

## 代码内固定值（无开关）

以下常量的调整需要改代码，配置文档不应承诺它们可调：AI 请求最小间隔 250 ms；健康探测超时 8000 ms、最小间隔 300 ms；AI 批量大小 20/40 与 90/60/180 秒超时、重试退避 `[500, 2000]` ms；会话 TTL 与上限；`readJson` 的 1 MiB 上限；元数据与健康探测的 User-Agent。

## 备份清单

需要一起保存的是 `ops/.env`（含四个密钥/凭证）与整个 `ops/data/`。只备数据不备 `AI_CONFIG_ENCRYPTION_KEY`，恢复后 AI 功能会失效；只备 `.env` 不备数据，目录与任务历史会丢失。
