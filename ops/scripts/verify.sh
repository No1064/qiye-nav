#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$OPS_DIR/.env"
COMPOSE_FILE="$OPS_DIR/docker-compose.yml"
WAIT_SECONDS=0

if [[ "${1:-}" == "--wait" ]]; then
  WAIT_SECONDS="${2:-180}"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "错误：缺少 ops/.env。请先运行 ./scripts/start.sh。" >&2
  exit 1
fi

COMPOSE=(
  docker compose
  --project-directory "$OPS_DIR"
  --env-file "$ENV_FILE"
  -f "$COMPOSE_FILE"
)

"${COMPOSE[@]}" config --quiet

service_list="$("${COMPOSE[@]}" config --services | sort | tr '\n' ' ' | sed 's/ $//')"
if [[ "$service_list" != "gateway ingest" ]]; then
  echo "错误：Compose 应且仅应包含 gateway 与 ingest，实际为：$service_list" >&2
  exit 1
fi

if "${COMPOSE[@]}" config | grep -q 'DASHY_'; then
  echo "错误：Compose 仍包含 DASHY_* 环境变量。" >&2
  exit 1
fi

if ! "${COMPOSE[@]}" config | grep -q 'AI_CONFIG_ENCRYPTION_KEY:'; then
  echo "错误：Compose 未向 Nav Server 提供 AI 配置加密密钥。" >&2
  exit 1
fi

published_port() {
  local service="$1" container_port="$2"
  "${COMPOSE[@]}" port "$service" "$container_port" 2>/dev/null | awk -F: 'END { print $NF }'
}

http_ready() {
  local gateway_port ingest_port
  gateway_port="$(published_port gateway 8080)"
  ingest_port="$(published_port ingest 3000)"
  [[ -n "$gateway_port" && -n "$ingest_port" ]] || return 1
  curl --fail --silent --show-error --max-time 4 \
    "http://127.0.0.1:${gateway_port}/" >/dev/null 2>&1 || return 1
  curl --fail --silent --show-error --max-time 4 \
    "http://127.0.0.1:${gateway_port}/manage/" >/dev/null 2>&1 || return 1
  curl --fail --silent --show-error --max-time 4 \
    "http://127.0.0.1:${gateway_port}/api/v1/catalog" >/dev/null 2>&1 || return 1
  curl --fail --silent --show-error --max-time 4 \
    "http://127.0.0.1:${gateway_port}/health" >/dev/null 2>&1 || return 1
  curl --fail --silent --show-error --max-time 4 \
    "http://127.0.0.1:${ingest_port}/health" >/dev/null 2>&1 || return 1
}

deadline=$((SECONDS + WAIT_SECONDS))
until http_ready; do
  if (( SECONDS >= deadline )); then
    echo "错误：服务未在 ${WAIT_SECONDS} 秒内就绪。" >&2
    "${COMPOSE[@]}" ps >&2
    exit 1
  fi
  sleep 2
done

if [[ ! -s "$OPS_DIR/data/catalog.json" ]]; then
  echo "错误：ops/data/catalog.json 不存在或为空。" >&2
  exit 1
fi

gateway_port="$(published_port gateway 8080)"
if ! curl --silent --show-error --dump-header - --output /dev/null --max-time 4 \
  "http://127.0.0.1:${gateway_port}/" \
  | tr -d '\r' \
  | awk 'tolower($1) == "x-content-type-options:" && tolower($2) == "nosniff" { found=1 } END { exit !found }'; then
  echo "错误：Gateway 未返回 X-Content-Type-Options: nosniff。" >&2
  exit 1
fi

if ! curl --silent --show-error --dump-header - --output /dev/null --max-time 4 \
  "http://127.0.0.1:${gateway_port}/manage/" \
  | tr -d '\r' \
  | awk 'tolower($1) == "cache-control:" && tolower($0) ~ /no-store/ { found=1 } END { exit !found }'; then
  echo "错误：Gateway 未对管理页返回 Cache-Control: no-store。" >&2
  exit 1
fi

admin_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 4 \
  "http://127.0.0.1:${gateway_port}/api/v1/admin/catalog")"
if [[ "$admin_status" != "401" ]]; then
  echo "错误：未登录的同源管理 API 应返回 401，实际为 $admin_status。" >&2
  exit 1
fi

session_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 4 \
  "http://127.0.0.1:${gateway_port}/api/v1/admin/auth/session")"
if [[ "$session_status" != "401" ]]; then
  echo "错误：未登录的管理会话接口应返回 401，实际为 $session_status。" >&2
  exit 1
fi

echo "正在校验 Caddy 配置…"
"${COMPOSE[@]}" exec -T gateway caddy validate \
  --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

echo "正在校验目录文件、版本摘要、稳定 ID 与公开 API…"
"${COMPOSE[@]}" exec -T ingest node --input-type=module -e '
  import { createHash } from "node:crypto";
  import { constants } from "node:fs";
  import { access, readFile } from "node:fs/promises";

  const encryptionKey = process.env.AI_CONFIG_ENCRYPTION_KEY || "";
  const decodedKeyLength = /^[0-9a-f]{64}$/i.test(encryptionKey)
    ? Buffer.from(encryptionKey, "hex").length
    : Buffer.from(encryptionKey, "base64").length;
  if (decodedKeyLength !== 32) throw new Error("AI config encryption key must decode to 32 bytes");

  Promise.all([
    readFile(process.env.CATALOG_PATH, "utf8"),
    fetch("http://gateway:8080/api/v1/catalog"),
    access(process.env.CATALOG_BACKUP_DIR, constants.R_OK | constants.W_OK),
  ]).then(async ([raw, response]) => {
    if (!response.ok) {
      throw new Error(`Public catalog API returned HTTP ${response.status}`);
    }
    const catalog = JSON.parse(raw);
    const publicCatalog = await response.json();
    const payload = {
      schemaVersion: catalog.schemaVersion,
      settings: catalog.settings,
      groups: catalog.groups,
    };
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (catalog.schemaVersion !== 1) throw new Error("catalog schemaVersion must be 1");
    if (catalog.version !== digest) throw new Error("catalog version digest mismatch");
    if (!Array.isArray(catalog.groups)) throw new Error("catalog groups must be an array");
    if (publicCatalog.version !== catalog.version) throw new Error("API / file version mismatch");
    if (publicCatalog.groups?.length !== catalog.groups.length) {
      throw new Error("API / file group count mismatch");
    }
    for (const group of catalog.groups) {
      if (!uuid.test(group.id)) throw new Error(`invalid group UUID: ${group.id}`);
      if (!Array.isArray(group.items)) throw new Error(`items missing for group ${group.id}`);
      for (const item of group.items) {
        if (!uuid.test(item.id)) throw new Error(`invalid item UUID: ${item.id}`);
      }
    }
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
'

"${COMPOSE[@]}" ps
echo "验证通过：共享导航界面、管理页、公开目录、数据文件、备份目录和 Gateway 均可用。"
