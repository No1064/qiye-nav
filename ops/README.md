# Docker 运维

见 [部署与维护](../docs/deployment.md)。在本目录运行脚本：

```sh
./scripts/set-admin-password.sh
./scripts/start.sh
./scripts/verify.sh --wait 180
```

预构建镜像使用 `--prebuilt` 参数。`.env` 和 `data/` 为私有运行数据，不提交。`dashy/conf.example.yml` 是公开的首次初始化示例。
