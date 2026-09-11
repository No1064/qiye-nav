# API 概览

服务默认监听 3000，由网关对外提供统一入口。接口以当前 `services/ingest/src/routes/` 与 `app.ts` 为准；详细请求与返回示例可参阅对应 `services/ingest/tests/` 测试。

- `GET /health`：存活检查。
- `GET /api/v1/catalog`：公开目录读取。
- `/api/v1/admin/`：管理接口，使用管理员会话 cookie；修改操作校验 CSRF。
- `POST /api/v1/admin/auth/password`：验证当前密码并修改管理员密码；成功后所有管理会话失效。
- `GET /api/v1/icons/:itemId?source=...`：已知目录条目的图标代理与缓存，只允许受验证的图标候选来源。

扩展通过配置的设备令牌访问采集接口。建议直接复用 `extension/background.js` 与 `extension/shared.js`的客户端实现与对应测试，避免混用管理会话和设备凭证。

AI 整理先产生预览，应用与回滚分别记录任务状态。书签检查产生问题与治理动作；缺失标题/介绍的智能补足使用 AI 整理功能。批量导入支持幂等键，重试时需复用原键。
