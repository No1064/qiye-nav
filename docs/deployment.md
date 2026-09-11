# 部署与维护

## 从源码部署

安装 Docker Engine / Desktop 和 Compose v2。使用有 Docker 权限的普通用户操作：

```sh
git clone https://github.com/No1064/qiye.git
cd qiye/ops
./scripts/set-admin-password.sh
./scripts/start.sh
```

首次设置会创建 `ops/.env`。密码隐藏输入，至少 12 字节；没有通用的 admin 默认密码。启动脚本生成设备令牌和 AI 加密密钥，新实例使用 `ops/dashy/conf.example.yml` 的示例目录。网页为 `http://127.0.0.1:8080`，管理后台 `/manage/`。

## 预构建镜像

```sh
export QIYE_IMAGE=ghcr.io/no1064/qiye:0.2.0
docker pull "$QIYE_IMAGE"
cd ops
./scripts/set-admin-password.sh --prebuilt
./scripts/start.sh --prebuilt
```

在 `ops/.env` 将 `QIYE_IMAGE` 设置为同一镜像名以便以后启动。镜像支持 Linux amd64 和 arm64。

## 离线镜像包

下载 Release 中与服务器 CPU 对应的 `qiye-0.2.0-images-amd64.tar.gz` 或 `qiye-0.2.0-images-arm64.tar.gz`，同时下载源码包。校验 SHA256SUMS 后解压源码：

```sh
gunzip -c qiye-0.2.0-images-amd64.tar.gz | docker load
cd qiye-0.2.0/ops
./scripts/set-admin-password.sh --prebuilt
./scripts/start.sh --prebuilt
```

离线包包含应用 `qiye:0.2.0` 和网关 `caddy:2.10.2-alpine`，无需现场编译。离线期间网页外部图标、元数据和 AI 功能仍需要网络才能获取新资料。

## 配置

完整配置示例见 [`ops/.env.example`](../ops/.env.example)。

| 变量 | 用途 |
| --- | --- |
| `QIYE_IMAGE` | 应用镜像，默认 `qiye:0.2.0` |
| `GATEWAY_PORT` / `INGEST_PORT` | 默认 8080 / 8787 |
| `BIND_ADDRESS` | 默认 127.0.0.1；局域网可设主机地址 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` | 初始化管理员凭证，由脚本设置 |
| `INGEST_TOKEN` | 扩展设备写入凭证，不要公开 |
| `AI_CONFIG_ENCRYPTION_KEY` | AI 配置加密密钥，必须妥善备份 |
| `ADMIN_COOKIE_SECURE` | HTTPS 部署设为 true |
| `CORS_ALLOWED_ORIGINS` | 允许的跨域来源，逗号分隔；留空使用服务默认策略 |

公网访问需自己配置域名与 HTTPS 反向代理；本项目默认网关不自动申请证书。公开目录不要求登录，请先阅读 [安全政策](../SECURITY.md)。

## 密码、备份与升级

- 后台「账号安全」可验证当前密码并修改密码，所有已有管理会话随即撤销。
- 忘记密码：在 ops 中重新执行 `./scripts/set-admin-password.sh --prebuilt`，然后 `./scripts/start.sh --prebuilt`；新的启动凭证会覆盖旧密码状态。
- 升级前先停止写入并备份整个 `ops/data/` 及 `ops/.env`，然后更新源码/镜像并启动。数据结构备份不能代替配置加密密钥备份。
- 恢复时停止实例，恢复同一批次的数据和配置，并确保 data 目录归启动用户所有。
- `docker compose --env-file .env logs --tail=100 ingest` 查看日志；`./scripts/verify.sh --wait 180` 检查服务。
- `docker compose --env-file .env down` 停止，不会删除绑定挂载的数据目录。

已有 Dashy 用户可将自己的 `conf.yml` 放在 `ops/dashy/` 后运行迁移脚本；已有 catalog 时不会默认覆盖。首次迁移前应备份，个人配置不得提交到 Git。
