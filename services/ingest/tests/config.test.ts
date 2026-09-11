import assert from "node:assert/strict";
import test from "node:test";
import { loadAppConfig } from "../src/config.js";

const PASSWORD_HASH =
  "scrypt$16384$8$1$B3pg-7P7gN4tp48ewqEqyQ$Q2vxixuCMcVBfVZFZzPKSzNhgT6ZuXEbcUHhBCtQGgI";

test("admin credentials and secure-cookie policy load from explicit environment settings", () => {
  const config = loadAppConfig({
    INGEST_TOKEN: "extension-only-token",
    ADMIN_USERNAME: "owner",
    ADMIN_PASSWORD_HASH: PASSWORD_HASH,
    ADMIN_COOKIE_SECURE: "true",
    CATALOG_PATH: "/tmp/catalog.json",
    AI_CONFIG_ENCRYPTION_KEY: "00".repeat(32),
  });
  assert.equal(config.ingestToken, "extension-only-token");
  assert.equal(config.adminUsername, "owner");
  assert.equal(config.adminPasswordHash, PASSWORD_HASH);
  assert.equal(config.adminCookieSecure, true);
});

test("startup rejects missing or malformed administrator password hashes", () => {
  assert.throws(
    () => loadAppConfig({ INGEST_TOKEN: "token", ADMIN_USERNAME: "owner" }),
    /ADMIN_PASSWORD_HASH is required/,
  );
  assert.throws(
    () => loadAppConfig({
      INGEST_TOKEN: "token",
      ADMIN_USERNAME: "owner",
      ADMIN_PASSWORD_HASH: "plaintext-is-forbidden",
    }),
    /Unsupported password hash format/,
  );
});

test("startup requires an exact 32-byte AI configuration encryption key", () => {
  const base = {
    INGEST_TOKEN: "token",
    ADMIN_USERNAME: "owner",
    ADMIN_PASSWORD_HASH: PASSWORD_HASH,
  };
  assert.throws(() => loadAppConfig(base), /AI_CONFIG_ENCRYPTION_KEY is required/);
  assert.throws(
    () => loadAppConfig({
      ...base,
      AI_CONFIG_ENCRYPTION_KEY: Buffer.alloc(31, 1).toString("base64"),
    }),
    /exactly 32 bytes/,
  );
  assert.equal(
    loadAppConfig({ ...base, AI_CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") })
      .aiConfigEncryptionKey.length,
    32,
  );
});
