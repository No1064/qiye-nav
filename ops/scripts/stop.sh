#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$OPS_DIR/.env"
COMPOSE_FILE="$OPS_DIR/docker-compose.yml"
BOOTSTRAP_ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

if [[ ! -f "$ENV_FILE" ]]; then
  echo "未找到 ops/.env；没有由启动脚本创建的环境需要停止。"
  exit 0
fi

# Allow stopping a pre-AI stack whose legacy .env does not yet contain the key.
AI_CONFIG_ENCRYPTION_KEY="${AI_CONFIG_ENCRYPTION_KEY:-$BOOTSTRAP_ENCRYPTION_KEY}" docker compose \
  --project-directory "$OPS_DIR" \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  down --remove-orphans

echo "服务已停止；ops/data 目录与 ops/dashy 回退归档均已保留。"
