#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$OPS_DIR/.env"
COMPOSE_FILE="$OPS_DIR/docker-compose.yml"
BOOTSTRAP_ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
CATALOG_FILE="$OPS_DIR/data/catalog.json"
ARCHIVE_FILE="$OPS_DIR/dashy/conf.yml"
MIGRATION_SOURCE=/migration/conf.yml
if [[ ! -f "$ARCHIVE_FILE" ]]; then
  ARCHIVE_FILE="$OPS_DIR/dashy/conf.example.yml"
  MIGRATION_SOURCE=/migration/conf.example.yml
fi
CHECK_SOURCE_COUNTS=0

if [[ ! -f "$ENV_FILE" ]]; then
  echo "错误：缺少 ops/.env。请先运行 ./scripts/start.sh。" >&2
  exit 1
fi

if [[ ! -r "$ARCHIVE_FILE" ]]; then
  echo "错误：迁移源不可读：ops/dashy/conf.yml" >&2
  exit 1
fi

mkdir -p "$OPS_DIR/data/backups"
export NAV_UID="${NAV_UID:-$(id -u)}"
export NAV_GID="${NAV_GID:-$(id -g)}"

if [[ ! -w "$OPS_DIR/data" || ! -w "$OPS_DIR/data/backups" ]]; then
  echo "错误：当前宿主用户无法写入 ops/data 或 ops/data/backups。" >&2
  echo "请修正目录归属，不要使用 chmod 777。" >&2
  exit 1
fi

COMPOSE=(
  docker compose
  --project-directory "$OPS_DIR"
  --env-file "$ENV_FILE"
  -f "$COMPOSE_FILE"
)

# The migration CLI does not use AI configuration. This fallback only lets an
# older .env pass Compose interpolation; start.sh creates the real random key.
export AI_CONFIG_ENCRYPTION_KEY="${AI_CONFIG_ENCRYPTION_KEY:-$BOOTSTRAP_ENCRYPTION_KEY}"

# Compose runs Nav Server with the same UID/GID. Confirm bind-mount permissions
# before creating or replacing any catalog file.
"${COMPOSE[@]}" run --rm --no-deps ingest node --input-type=module -e '
  import { constants } from "node:fs";
  import { access } from "node:fs/promises";
  await access("/app/data", constants.R_OK | constants.W_OK);
  await access("/app/data/backups", constants.R_OK | constants.W_OK);
'

if [[ -f "$CATALOG_FILE" ]]; then
  echo "目录已存在，不执行覆盖迁移；正在做切换前完整性校验。"
else
  CHECK_SOURCE_COUNTS=1
  echo "正在从只读 Dashy 归档迁移网址目录…"
  "${COMPOSE[@]}" run --rm --no-deps ingest \
    node dist/migration.js \
    --input "$MIGRATION_SOURCE" \
    --output /app/data/catalog.json \
    --backups /app/data/backups
fi

if [[ ! -s "$CATALOG_FILE" ]]; then
  echo "错误：迁移命令未生成非空 catalog.json；现有服务尚未切换。" >&2
  exit 1
fi

"${COMPOSE[@]}" run --rm --no-deps \
  -e "CHECK_SOURCE_COUNTS=$CHECK_SOURCE_COUNTS" -e "MIGRATION_SOURCE=$MIGRATION_SOURCE" \
  ingest node --input-type=module -e '
  import { createHash } from "node:crypto";
  import { readFile } from "node:fs/promises";
  import YAML from "yaml";

  const source = process.env.CHECK_SOURCE_COUNTS === "1" ? YAML.parse(await readFile(process.env.MIGRATION_SOURCE, "utf8")) : {};
  const catalog = JSON.parse(await readFile("/app/data/catalog.json", "utf8"));
  const sourceGroups = Array.isArray(source.sections) ? source.sections : [];
  const sourceItems = sourceGroups.reduce(
    (total, group) => total + (Array.isArray(group.items) ? group.items.length : 0),
    0,
  );
  const targetGroups = Array.isArray(catalog.groups) ? catalog.groups : [];
  const targetItems = targetGroups.reduce(
    (total, group) => total + (Array.isArray(group.items) ? group.items.length : 0),
    0,
  );
  const payload = {
    schemaVersion: catalog.schemaVersion,
    settings: catalog.settings,
    groups: catalog.groups,
  };
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

  if (catalog.schemaVersion !== 1) throw new Error("catalog schemaVersion must be 1");
  if (catalog.version !== digest) throw new Error("catalog version digest mismatch");
  if (
    process.env.CHECK_SOURCE_COUNTS === "1"
    && (sourceGroups.length !== targetGroups.length || sourceItems !== targetItems)
  ) {
    throw new Error(
      `migration count mismatch: source ${sourceGroups.length}/${sourceItems}, target ${targetGroups.length}/${targetItems}`,
    );
  }
  console.log(`目录完整：${targetGroups.length} 个分组、${targetItems} 个网址。`);
'

echo "目录预检完成；ops/dashy/conf.yml 保持原样，可用于回退。"
