import type { AppConfig } from "./types.js";
import { dirname, join, resolve } from "node:path";
import { parsePasswordHash } from "./password.js";

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function booleanEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function encryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = required(env, "AI_CONFIG_ENCRYPTION_KEY");
  let key: Buffer;
  if (/^[a-f\d]{64}$/i.test(raw)) key = Buffer.from(raw, "hex");
  else {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) {
      throw new Error("AI_CONFIG_ENCRYPTION_KEY must be 64 hex characters or base64");
    }
    key = Buffer.from(raw, "base64");
  }
  if (key.length !== 32) {
    throw new Error("AI_CONFIG_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const corsAllowedOrigins = new Set(
    (env.CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  const catalogPath = resolve(env.CATALOG_PATH?.trim() || "/app/data/catalog.json");
  const catalogInitPath = env.CATALOG_INIT_PATH?.trim();
  const adminPasswordHash = required(env, "ADMIN_PASSWORD_HASH");
  const adminUsername = required(env, "ADMIN_USERNAME");
  if (adminUsername.length > 200) throw new Error("ADMIN_USERNAME must be at most 200 characters");
  parsePasswordHash(adminPasswordHash);
  return {
    port: integerEnv(env, "PORT", 3000, 1, 65_535),
    ingestToken: required(env, "INGEST_TOKEN"),
    corsAllowedOrigins,
    allowLocalUrls: booleanEnv(env, "ALLOW_LOCAL_URLS", true),
    defaultGroup: env.DEFAULT_GROUP?.trim() || "收件箱",
    fetchTimeoutMs: integerEnv(env, "FETCH_TIMEOUT_MS", 5_000, 100, 30_000),
    fetchMaxBytes: integerEnv(env, "FETCH_MAX_BYTES", 1_048_576, 1_024, 5_242_880),
    idempotencyTtlMs:
      integerEnv(env, "IDEMPOTENCY_TTL_SECONDS", 86_400, 60, 604_800) * 1_000,
    catalogPath,
    catalogBackupDir: resolve(
      env.CATALOG_BACKUP_DIR?.trim() || join(dirname(catalogPath), "backups"),
    ),
    ...(catalogInitPath ? { catalogInitPath: resolve(catalogInitPath) } : {}),
    adminUsername,
    adminPasswordHash,
    adminCookieSecure: booleanEnv(env, "ADMIN_COOKIE_SECURE", false),
    aiConfigPath: resolve(
      env.AI_CONFIG_PATH?.trim() || join(dirname(catalogPath), "ai-config.enc.json"),
    ),
    aiJobsPath: resolve(env.AI_JOBS_PATH?.trim() || join(dirname(catalogPath), "ai-jobs.json")),
    importSessionsPath: resolve(
      env.IMPORT_SESSIONS_PATH?.trim() || join(dirname(catalogPath), "import-sessions.json"),
    ),
    healthJobsPath: resolve(
      env.HEALTH_JOBS_PATH?.trim() || join(dirname(catalogPath), "health-jobs.json"),
    ),
    aiConfigEncryptionKey: encryptionKey(env),
  };
}
