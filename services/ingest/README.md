# 栖页服务

Node.js 22+ / TypeScript，提供目录、管理员会话、书签采集、AI 整理、检查任务与静态页面。

从仓库根目录执行 `npm run setup`、`npm run build`、`python3 scripts/init-dev.py`、`npm run dev`。独立服务测试为 `npm --prefix services/ingest test`。

配置见 [`.env.example`](.env.example)，数据默认保存在运行目录的 data 中。生产部署见 [Docker 指南](../../docs/deployment.md)。首页由 extension 同步生成，不要直接修改 public/home 的共享文件。
