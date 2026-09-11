# 发布指南

1. 更新根 package、各子 package、后端 lockfile、扩展 manifest 的版本，以及 Compose、Dockerfile、示例配置和文档中的版本。
2. 运行 `npm run setup && npm run check && npm test`。
3. 运行 `npm run release:source`。导出使用明确的路径清单，排除私人配置、数据、构建缓存与原 Git 历史；输出在 `releases/`。
4. 运行 `npm run release:images`，生成 amd64/arm64 的应用与 Caddy 离线镜像包。需要 Docker buildx、多架构模拟支持及足够磁盘空间。
5. 提交修改并推送 `v<版本>` 标签。GitHub Actions 验证代码并向 `ghcr.io/<仓库所有者>/qiye` 发布多架构镜像。
6. 创建 GitHub Release，上传源码、扩展 zip、镜像包与校验和。首次创建 GHCR 包后，维护者需确认包的公开可见性，并验证匿名拉取。

Fork 发布需要根据新仓库更新 README 链接和 Dockerfile 的 source 标签。构建镜像的工作流使用仓库 GITHUB_TOKEN，不需要在源码中配置 Docker 密码。

`release-manifest.json` 控制源码导出范围。不要以原始工作目录或 `git archive` 替代导出检查，历史和未跟踪文件可能分别包含私人数据或必要源码。
