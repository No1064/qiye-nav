import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { importBookmarkBatch, parseBookmarkBatch } from "../batch-import.js";
import type { IdempotencyStore } from "../idempotency.js";
import type { ImportSessions } from "../import-sessions.js";
import { parseBookmarkInput } from "../validation.js";
import { summarizeHealthJobs } from "../health-summary.js";
import type { HealthJobs } from "../health-jobs.js";
import type {
  AppConfig,
  BookmarkInput,
  CatalogRepository,
  HttpResult,
} from "../types.js";

interface PublicRoutesContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  corsHeaders: Record<string, string>;
  config: AppConfig;
  store: CatalogRepository;
  idempotency: IdempotencyStore;
  importSessions: ImportSessions;
  requireAuth: (request: IncomingMessage, expected: string) => void;
  readJson: (request: IncomingMessage, optional?: boolean) => Promise<unknown>;
  idempotencyKey: (request: IncomingMessage) => string;
  serialWrite: <T>(operation: () => Promise<T>) => Promise<T>;
  createBookmark: (input: BookmarkInput) => Promise<HttpResult>;
  healthJobs?: HealthJobs;
  json: (
    response: ServerResponse,
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ) => void;
}

function fingerprint(input: unknown, namespace = "bookmark"): string {
  return createHash("sha256").update(namespace).update("\0").update(JSON.stringify(input)).digest("hex");
}

export async function handlePublicRoutes(context: PublicRoutesContext): Promise<boolean> {
  const {
    request, response, url, corsHeaders, config, store, idempotency, importSessions,
    requireAuth, readJson, idempotencyKey, serialWrite, createBookmark, json, healthJobs,
  } = context;

  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
    json(response, 200, { status: "ok", service: "nav-ingest" }, corsHeaders);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/groups") {
    requireAuth(request, config.ingestToken);
    json(response, 200, { groups: await store.listGroups() }, corsHeaders);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/catalog") {
    const catalog = await store.getCatalog();
    json(
      response,
      200,
      { version: catalog.version, settings: catalog.settings, groups: catalog.groups },
      { ...corsHeaders, etag: `"${catalog.version}"` },
    );
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/health/summary") {
    const latest = healthJobs ? await healthJobs.latestCompleted() : null;
    json(response, 200, summarizeHealthJobs(latest ? [latest] : []), {
      ...corsHeaders,
      "cache-control": "no-store",
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/bookmarks") {
    requireAuth(request, config.ingestToken);
    const key = idempotencyKey(request);
    const input = parseBookmarkInput(await readJson(request));
    const replay = await idempotency.run(key, fingerprint(input), () =>
      serialWrite(() => createBookmark(input)),
    );
    json(response, replay.result.status, replay.result.body, {
      ...corsHeaders,
      ...(replay.replayed ? { "idempotent-replayed": "true" } : {}),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/bookmarks/batch") {
    requireAuth(request, config.ingestToken);
    const key = idempotencyKey(request);
    const input = parseBookmarkBatch(await readJson(request));
    const replay = await idempotency.run(key, fingerprint(input, "bookmark-batch"), async () => ({
      status: 200,
      body: await serialWrite(() => importBookmarkBatch(store, input, importSessions)),
    }));
    json(response, replay.result.status, replay.result.body, {
      ...corsHeaders,
      ...(replay.replayed ? { "idempotent-replayed": "true" } : {}),
    });
    return true;
  }

  return false;
}
