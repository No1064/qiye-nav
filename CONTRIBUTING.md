# 贡献指南

欢迎提交问题与 Pull Request。贡献代码采用本项目 MIT 许可证。

## 开发

需要 Node.js 22+、npm；本地初始化配置还需要 Python 3。

```sh
npm run setup
npm run build
python3 scripts/init-dev.py
npm run dev
```

服务配置位于 `services/ingest/.env`，数据位于该服务的 `data/`。不要提交它们。

## 修改与验证

- 网页首页与扩展新标签页共享源码。修改 `extension/` 后运行 `npm run sync`，提交同步结果。
- 后端位于 `services/ingest/src/`，管理页面位于 `services/ingest/public/manage/`。
- 修复应附能覆盖实际行为的测试；文案或样式修改提供操作验证即可。
- 提交前运行 `npm run check` 和 `npm test`。
- PR 说明问题、修改后的行为及验证结果。避免混入无关格式化与个人配置。
- 漏洞请遵循 [安全政策](SECURITY.md)，不要公开密钥或未修复漏洞的利用细节。

## 发布

见 [发布指南](docs/releasing.md)。维护者检查版本、测试、源码包与镜像后发布标签。
