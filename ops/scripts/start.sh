#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$OPS_DIR/.env"
ENV_EXAMPLE="$OPS_DIR/.env.example"
COMPOSE_FILE="$OPS_DIR/docker-compose.yml"

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "错误：未找到 Docker，请先安装 Docker Desktop 或 Docker Engine。" >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "错误：需要 Docker Compose v2（docker compose）。" >&2
    exit 1
  fi
}

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

create_env_if_missing() {
  if [[ -f "$ENV_FILE" ]]; then
    return
  fi

  local ingest_token
  ingest_token="$(random_token)"
  umask 077
  sed \
    -e "s/change-me-ingest-token/$ingest_token/" \
    "$ENV_EXAMPLE" > "$ENV_FILE"
  echo "已创建 ops/.env，并生成 Ingest 访问令牌。"
}

ensure_ai_encryption_key() {
  local current_key encryption_key temp_file
  current_key="$(sed -n 's/^AI_CONFIG_ENCRYPTION_KEY=//p' "$ENV_FILE" | tail -n 1)"
  if [[ -n "$current_key" && "$current_key" != "change-me-ai-config-encryption-key" ]]; then
    return
  fi
  encryption_key="$(random_token)"
  temp_file="$(mktemp "$OPS_DIR/.env.tmp.XXXXXX")"
  awk -v key="$encryption_key" '
    BEGIN { updated = 0 }
    /^AI_CONFIG_ENCRYPTION_KEY=/ {
      if (!updated) print "AI_CONFIG_ENCRYPTION_KEY=" key
      updated = 1
      next
    }
    { print }
    END { if (!updated) print "AI_CONFIG_ENCRYPTION_KEY=" key }
  ' "$ENV_FILE" > "$temp_file"
  chmod 600 "$temp_file"
  mv "$temp_file" "$ENV_FILE"
  echo "已生成 AI 配置加密密钥（未打印）。"
}

require_admin_credentials() {
  local username hash
  username="$(sed -n 's/^ADMIN_USERNAME=//p' "$ENV_FILE" | tail -n 1)"
  hash="$(sed -n 's/^ADMIN_PASSWORD_HASH=//p' "$ENV_FILE" | tail -n 1)"
  hash="${hash#\'}"
  hash="${hash%\'}"
  hash="${hash#\"}"
  hash="${hash%\"}"
  if [[ -z "$username" || "$hash" != scrypt\$* ]]; then
    echo "错误：尚未配置管理员账号。请先运行 ./scripts/set-admin-password.sh。" >&2
    exit 1
  fi
}

PREBUILT=0
if [[ "${1:-}" == "--prebuilt" ]]; then PREBUILT=1; elif [[ $# -gt 0 ]]; then echo "用法：$0 [--prebuilt]" >&2; exit 2; fi

require_docker
create_env_if_missing
require_admin_credentials
ensure_ai_encryption_key

# Match bind-mounted data ownership without running Nav Server as root.
export NAV_UID="$(id -u)"
export NAV_GID="$(id -g)"
if [[ "$NAV_UID" == "0" ]]; then
  echo "错误：请使用有 Docker 权限的普通用户运行，不要以 root 启动。" >&2
  exit 1
fi

mkdir -p "$OPS_DIR/data/backups"

# The extension new-tab surface is the single UI source for both Chrome and the web home.
if command -v node >/dev/null 2>&1; then
  node "$OPS_DIR/../scripts/sync-newtab-home.mjs"
else
  echo "未检测到 Node.js，使用发布包内已同步的首页资源。"
fi

# Build and migrate first. The currently running stack remains untouched if either fails.
if [[ "$PREBUILT" == "0" ]]; then
  docker compose --project-directory "$OPS_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build ingest
fi

"$SCRIPT_DIR/migrate.sh"

docker compose \
  --project-directory "$OPS_DIR" \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  up --detach --no-build --remove-orphans

"$SCRIPT_DIR/verify.sh" --wait "${STARTUP_TIMEOUT_SECONDS:-180}"

gateway_port="$(docker compose \
  --project-directory "$OPS_DIR" \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  port gateway 8080 | awk -F: 'END { print $NF }')"
echo "导航站已启动：http://127.0.0.1:${gateway_port:-8080}"
echo "管理网址：http://127.0.0.1:${gateway_port:-8080}/manage/"
