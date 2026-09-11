#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$OPS_DIR/.env"
ENV_EXAMPLE="$OPS_DIR/.env.example"
COMPOSE_FILE="$OPS_DIR/docker-compose.yml"
BOOTSTRAP_HASH='scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
BOOTSTRAP_ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

if [[ "${1:-}" == "--help" ]]; then
  echo "用法：./scripts/set-admin-password.sh [--prebuilt]"
  echo "安全地设置 ADMIN_PASSWORD_HASH；密码通过隐藏提示读取，不进入命令行参数。"
  exit 0
fi
PREBUILT=0
if [[ "${1:-}" == "--prebuilt" ]]; then PREBUILT=1; shift; fi
if (( $# > 0 )); then
  echo "错误：此脚本不接受密码参数，请按隐藏提示输入。" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "错误：需要 Docker 和 Docker Compose v2。" >&2
  exit 1
fi

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  sed "s/change-me-ingest-token/$(random_token)/" "$ENV_EXAMPLE" > "$ENV_FILE"
  echo "已创建 ops/.env，并生成扩展专用令牌。"
fi

current_username="$(sed -n 's/^ADMIN_USERNAME=//p' "$ENV_FILE" | tail -n 1)"
current_username="${current_username:-admin}"
printf "管理员用户名（默认 %s）：" "$current_username"
IFS= read -r username
username="${username:-$current_username}"
if [[ ! "$username" =~ ^[A-Za-z0-9._@-]{1,64}$ ]]; then
  echo "错误：用户名仅可包含字母、数字及 . _ @ -，最长 64 个字符。" >&2
  exit 1
fi

printf "管理员密码（至少 12 字节）："
IFS= read -r -s password
printf "\n再次输入管理员密码："
IFS= read -r -s confirmation
printf "\n"
trap 'unset password confirmation' EXIT

if [[ "$password" != "$confirmation" ]]; then
  echo "错误：两次输入的密码不一致。" >&2
  exit 1
fi
password_bytes="$(LC_ALL=C printf '%s' "$password" | wc -c | tr -d ' ')"
if (( password_bytes < 12 || password_bytes > 1024 )); then
  echo "错误：密码长度必须为 12 至 1024 字节。" >&2
  exit 1
fi

COMPOSE=(
  docker compose
  --project-directory "$OPS_DIR"
  --env-file "$ENV_FILE"
  -f "$COMPOSE_FILE"
)
if [[ "$PREBUILT" == "0" ]]; then
ADMIN_USERNAME="$username" ADMIN_PASSWORD_HASH="$BOOTSTRAP_HASH" AI_CONFIG_ENCRYPTION_KEY="$BOOTSTRAP_ENCRYPTION_KEY" \
  "${COMPOSE[@]}" build ingest >/dev/null
fi
hash="$(printf '%s\n' "$password" | ADMIN_USERNAME="$username" ADMIN_PASSWORD_HASH="$BOOTSTRAP_HASH" \
  AI_CONFIG_ENCRYPTION_KEY="$BOOTSTRAP_ENCRYPTION_KEY" \
  "${COMPOSE[@]}" run --rm --no-deps -T ingest node dist/password.js hash)"
if [[ ! "$hash" =~ ^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$ ]]; then
  echo "错误：密码哈希 CLI 返回了无效结果；ops/.env 未修改。" >&2
  exit 1
fi

temp_file="$(mktemp "$OPS_DIR/.env.tmp.XXXXXX")"
trap 'unset password confirmation hash; rm -f "${temp_file:-}"' EXIT
awk -v username="$username" -v hash="'$hash'" '
    BEGIN { username_updated = 0; hash_updated = 0 }
    /^ADMIN_USERNAME=/ {
      if (!username_updated) print "ADMIN_USERNAME=" username
      username_updated = 1
      next
    }
    /^ADMIN_PASSWORD_HASH=/ {
      if (!hash_updated) print "ADMIN_PASSWORD_HASH=" hash
      hash_updated = 1
      next
    }
    { print }
    END {
      if (!username_updated) print "ADMIN_USERNAME=" username
      if (!hash_updated) print "ADMIN_PASSWORD_HASH=" hash
    }
' "$ENV_FILE" > "$temp_file"
chmod 600 "$temp_file"
mv "$temp_file" "$ENV_FILE"
unset password confirmation hash
echo "管理员密码已安全写入 ops/.env。运行 ./scripts/start.sh 使配置生效。"
