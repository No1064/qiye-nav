# 栖页导航 · Qiye Nav

自托管的个人导航站：统一管理公开网站、NAS 入口和浏览器书签，使用 AI 辅助归类与补充资料。

[English](README.en.md) · [部署文档](docs/deployment.md) · [开发指南](CONTRIBUTING.md) · [API](docs/api.md) · [版本记录](CHANGELOG.md) · [MIT](LICENSE)

## 功能

- **导航桌面**：两级分组、全局搜索、键盘导航、浅深色主题；Web 与 Chrome 新标签页共享界面。
- **书签管理**：新增、编辑、排序、批量移动、HTML / JSON 导入导出，以及 NAS 公网与局域网双地址。
- **AI 整理**：标题、介绍、标签与分组建议；保守整理、平衡重组、完全重建，全部先审核后应用。
- **收件箱归类**：只分析选中来源，允许移入全部现有分组，不连带整理其他书签。
- **书签检查**：完全重复、空叶子分组、永久跳转与疑似失效提示；缺失资料可按书签精确交给 AI，只补空值。
- **浏览器扩展**：工具栏、右键、快捷键收藏；可选同步新书签、分批导入现有书签。
- **账号与数据**：管理员密码修改、Cookie 会话、CSRF 防护、加密保存 AI Key、写前备份与版本冲突保护。
- **图标缓存**：7 天服务端 / 浏览器缓存与成功来源记忆；无需每次刷新都请求第三方。

所有功能源码均包含在本仓库。无需账号服务、付费授权或 AI Key 即可使用基础导航与书签管理。AI 功能可选，模型调用由你配置的服务商计费。

## 快速开始

需要 Docker、Docker Compose v2、Bash 和 curl。Windows 请使用 WSL2；macOS 可使用 Docker Desktop 或 OrbStack。使用有 Docker 权限的普通用户操作。

```bash
git clone https://github.com/No1064/qiye-nav.git
cd qiye-nav
./ops/scripts/set-admin-password.sh
./ops/scripts/start.sh
```

首次设置管理员用户名和密码（没有默认密码），脚本自动生成扩展 Token 与独立加密密钥。新安装只导入公开示例：GitHub、MDN 和空收件箱；不含作者的书签或任何凭据。

- 导航首页：[localhost:8080](http://localhost:8080/)
- 管理后台：[localhost:8080/manage/](http://localhost:8080/manage/)
- 扩展 API：`http://127.0.0.1:8787`

默认只监听本机。服务器部署、HTTPS、备份、升级与恢复见[部署文档](docs/deployment.md)。基础导航不依赖 Dashy；旧 Dashy 数据可选迁移。

### 使用预构建镜像

```bash
export QIYE_IMAGE=ghcr.io/no1064/qiye:0.2.0
docker pull "$QIYE_IMAGE"
./ops/scripts/set-admin-password.sh --prebuilt
./ops/scripts/start.sh --prebuilt
```

保持 `QIYE_IMAGE` 环境变量，或将它写入本地 `ops/.env`。镜像支持 `linux/amd64` 和 `linux/arm64`。离线镜像包可从 [Releases](https://github.com/No1064/qiye-nav/releases) 下载，使用 `docker load -i 文件名.tar.gz` 导入；完整说明见[发布文档](docs/releasing.md)。

## 浏览器扩展

打开 `chrome://extensions`，开启开发者模式，加载仓库的 `extension/` 目录。设置 API 地址，从本机 `ops/.env` 复制 `INGEST_TOKEN`，然后授权并测试连接。Token 仅用于扩展，不能登录管理后台。

扩展的新标签页默认关闭，可在设置中开启。更新扩展文件后点击“重新加载”。详见[扩展文档](extension/README.md)。

## 开发

需要 Node.js 22+、npm，以及用于初始化 / 发布打包的 Python 3。

```bash
npm run setup
npm run build
python3 scripts/init-dev.py
npm run dev
```

开发服务位于 `http://localhost:3000`，开发数据存入 `services/ingest/data/`，不会读写 Docker 的 `ops/data/`。

```bash
npm run check        # TypeScript、共享首页一致性、发布检查
npm test             # 服务、管理页、首页、扩展全部测试
npm run release:source
npm run release:images
```

## 项目结构

```text
extension/                 Chrome 扩展与主页 UI 唯一源
services/ingest/src/        Node.js / TypeScript 服务
services/ingest/tests/      后端回归测试
services/ingest/public/     管理页和同步生成的 Web 主页
ops/                       Compose、Caddy、启动 / 迁移脚本
scripts/                   开发、同步、检查和发布工具
docs/                      架构、配置、API、部署、发布说明
.github/                   CI、镜像发布、Issue / PR 模板
```

## 数据与隐私

公开目录 API 为导航提供数据，因此可访问服务的人可能读取书签。不要把本机端口直接暴露到公网；使用 HTTPS 和访问控制。浏览器访问记录、备忘与对话历史保存在当前浏览器，AI 请求会把选中的内容发送到你配置的服务商。

`ops/.env`、运行数据、密码哈希、AI 配置和私人迁移输入不属于开源发布内容。备份这些本地文件时请自行妥善保存。更多说明见 [SECURITY.md](SECURITY.md)。

## 参与与许可

欢迎提交 Issue 和 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和[行为准则](CODE_OF_CONDUCT.md)。源码使用 MIT 许可证；依赖与外部图标的许可单独见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
