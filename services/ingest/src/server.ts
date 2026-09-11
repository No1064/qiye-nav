import { IconCache } from "./icon-cache.js";
import { dirname, join } from "node:path";
import { AdminCredentials } from "./admin-credentials.js";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { CatalogStore } from "./catalog-store.js";
import { loadAppConfig } from "./config.js";
import { createMetadataFetcher } from "./metadata.js";
import { AiClient } from "./ai-client.js";
import { AiConfigStore } from "./ai-config.js";
import { AiJobs } from "./ai-jobs.js";
import { ImportSessions } from "./import-sessions.js";
import { HealthJobs } from "./health-jobs.js";

const appConfig = loadAppConfig();
const adminCredentials = new AdminCredentials(join(dirname(appConfig.catalogPath), "admin-credentials.json"), appConfig.adminUsername, appConfig.adminPasswordHash);
appConfig.adminPasswordHash = await adminCredentials.load();
const store = await CatalogStore.open({
  catalogPath: appConfig.catalogPath,
  backupDir: appConfig.catalogBackupDir,
  ...(appConfig.catalogInitPath ? { initPath: appConfig.catalogInitPath } : {}),
  defaultGroup: appConfig.defaultGroup,
});
const fetchMetadata = createMetadataFetcher({
  timeoutMs: appConfig.fetchTimeoutMs,
  maxBytes: appConfig.fetchMaxBytes,
});
const aiConfigStore = new AiConfigStore(appConfig.aiConfigPath, appConfig.aiConfigEncryptionKey);
await aiConfigStore.initialize();
const aiClient = new AiClient();
const aiJobs = new AiJobs({
  path: appConfig.aiJobsPath,
  store,
  configStore: aiConfigStore,
  client: aiClient,
  minRequestIntervalMs: 250,
});
await aiJobs.initialize();
const importSessions = new ImportSessions(appConfig.importSessionsPath);
await importSessions.initialize();
const healthJobs = new HealthJobs({
  path: appConfig.healthJobsPath,
  store,
  timeoutMs: 8_000,
  minRequestIntervalMs: 300,
});
await healthJobs.initialize();
const server = createServer(createApp({
  config: appConfig,
  iconCache: new IconCache(join(dirname(appConfig.catalogPath), "icon-cache")),
  saveAdminPasswordHash: (hash) => adminCredentials.save(hash),
  store,
  fetchMetadata,
  aiConfigStore,
  aiJobs,
  aiClient,
  importSessions,
  healthJobs,
}));

server.listen(appConfig.port, "0.0.0.0", () => {
  console.info(`Nav Ingest listening on 0.0.0.0:${appConfig.port}`);
});

function shutdown(signal: string): void {
  console.info(`Received ${signal}; stopping Nav Ingest`);
  server.close((error) => {
    if (error) {
      console.error("Failed to stop cleanly", error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
