# 栖页网址管理前端

此目录是 `/manage/` 的原生 HTML、CSS、JavaScript 管理界面，无构建步骤和远程脚本依赖。

## 功能范围

- 管理员用户名密码登录，由 HttpOnly、SameSite Cookie 维持会话。
- CSRF Token 仅保存在页面运行内存，刷新后通过会话接口重新获取；密码和会话凭据不写入 Web Storage。
- 登录失效后自动返回登录页，支持主动安全退出。
- AI 模型配置支持 DeepSeek 预设和 OpenAI-compatible 服务；API Key 只提交服务端，读取时不回显，输入留空会保留现有 Key。
- AI 整理可选单个、多个或全部分组；选择父分组会包含其子分组。平衡重组与完全重建可生成“公司或领域 → 项目”的两级目标体系，目标数量按叶子项目组计算，并在校验失败的重试中带上具体修正原因。
- 站点名称、副标题、默认搜索引擎和局域网入口规则维护。
- 最多两级的分组新建、编辑、删除、同级拖拽排序和键盘按钮排序；父分组也可直接维护网址。
- 网址新建、编辑、删除、移动、拖拽排序和键盘按钮排序。
- 元数据预览，支持标题、介绍和 favicon 回填。
- 目标网站拒绝自动读取时显示中文降级说明，不阻止手工填写和保存。
- NAS 网址明确区分远程地址与局域网地址。
- 桌面侧栏、网址列表、编辑 drawer；手机顶部分组和底部 sheet。
- loading skeleton、空状态、错误状态、toast、二次确认和版本冲突刷新。
- 系统深浅主题、键盘焦点、`prefers-reduced-motion` 与 `prefers-reduced-transparency`。

功能图标使用仓库内的 Tabler 风格 MIT 轮廓图标 sprite，不加载图标 CDN。公开网站在 `icon: favicon` 或未提供图标时尝试 Icon Horse favicon，失败后显示首字 fallback。

## 验证

在本目录执行：

```bash
npm test
```

单元测试覆盖 catalog 兼容、搜索、标签、排序与错误翻译。静态校验覆盖登录、同源 Cookie、内存 CSRF、`If-Match`、无内联脚本、关键 UI、图标和响应式规则。
