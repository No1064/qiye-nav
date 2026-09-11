import type { IncomingMessage, ServerResponse } from "node:http";
import {
  applyBookmarkImportPlan,
  exportBookmarksHtml,
  exportCatalogJson,
  parseBookmarksHtml,
  parseCatalogBackup,
  planBookmarkImport,
  planJsonRestore,
} from "../bookmark-transfer.js";
import type { CatalogStore } from "../catalog-store.js";
import { HttpError } from "../errors.js";
import type { HealthAction } from "../health-governance.js";
import type { HealthJobs } from "../health-jobs.js";
import { parseCreateHealthJob } from "../health-job-input.js";
import type { CatalogRepository, DashyCatalog } from "../types.js";

interface Context {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  corsHeaders: Record<string, string>;
  store: CatalogRepository;
  healthJobs?: HealthJobs;
  logger: Pick<Console, "info" | "error">;
  readJson: (request: IncomingMessage, optional?: boolean, maximumBytes?: number) => Promise<unknown>;
  requestVersion: (request: IncomingMessage) => string;
  serialWrite: <T>(operation: () => Promise<T>) => Promise<T>;
  json: (response: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
}

export async function handleAdminHealthRoutes(context: Context): Promise<boolean> {
  const { request, response, url, corsHeaders, store, healthJobs, readJson, requestVersion, serialWrite, json, logger } = context;
  if (request.method === "GET" && url.pathname === "/api/v1/admin/health/jobs") {
    requireHealth(healthJobs);
    json(response, 200, await healthJobs.list(integer(url, "limit", 20, 1, 100), integer(url, "offset", 0, 0, 100_000)), corsHeaders);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/admin/health/jobs") {
    requireHealth(healthJobs);
    const input = parseCreateHealthJob(await readJson(request, true));
    json(response, 202, await healthJobs.create(input), corsHeaders);
    return true;
  }
  const jobRoute = url.pathname.match(/^\/api\/v1\/admin\/health\/jobs\/([^/]+)$/);
  const actionRoute = url.pathname.match(/^\/api\/v1\/admin\/health\/jobs\/([^/]+)\/(pause|resume|cancel|apply)$/);
  if (jobRoute && request.method === "GET") {
    requireHealth(healthJobs);
    json(response, 200, await healthJobs.get(decode(jobRoute[1]!)), corsHeaders);
    return true;
  }
  if (actionRoute && request.method === "POST") {
    requireHealth(healthJobs);
    const id = decode(actionRoute[1]!);
    const action = actionRoute[2]!;
    if (action === "pause") json(response, 200, await healthJobs.pause(id), corsHeaders);
    else if (action === "resume") json(response, 202, await healthJobs.resume(id), corsHeaders);
    else if (action === "cancel") json(response, 200, await healthJobs.cancel(id), corsHeaders);
    else {
      const expectedVersion = requestVersion(request);
      const input = objectValue(await readJson(request));
      const actions = parseHealthActions(input.actions);
      const capable = store as CatalogRepository & Pick<CatalogStore, "applyHealthChangeSet">;
      if (typeof capable.applyHealthChangeSet !== "function") unavailable("Health change sets are unavailable");
      const changeSet = await serialWrite(async () => {
        const current = await store.getCatalog();
        if (current.version !== expectedVersion) conflict(expectedVersion, current.version);
        return capable.applyHealthChangeSet(id, actions);
      });
      const catalog = await store.getCatalog();
      await healthJobs.recordChangeSet(id, changeSet);
      logger.info("Admin catalog mutation", { action: "health.change_set.apply", version: catalog.version });
      json(response, 200, { catalog, changeSet }, { ...corsHeaders, etag: `"${catalog.version}"` });
    }
    return true;
  }
  const restoreRoute = url.pathname.match(/^\/api\/v1\/admin\/health\/change-sets\/([^/]+)\/restore$/);
  if (restoreRoute && request.method === "POST") {
    const expectedVersion = requestVersion(request);
    const capable = store as CatalogRepository & Pick<CatalogStore, "restoreAiChangeSet">;
    if (typeof capable.restoreAiChangeSet !== "function") unavailable("Change set restore is unavailable");
    const restored = await serialWrite(() => capable.restoreAiChangeSet(decode(restoreRoute[1]!), expectedVersion));
    const catalog = await store.getCatalog();
    json(response, 200, { catalog, restored }, { ...corsHeaders, etag: `"${catalog.version}"` });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/admin/bookmarks/export") {
    const catalog = await store.getCatalog();
    const format = url.searchParams.get("format") ?? "html";
    if (!['html', 'json'].includes(format)) invalid("format must be html or json");
    const content = format === "html" ? exportBookmarksHtml(catalog) : exportCatalogJson(catalog);
    response.writeHead(200, {
      "content-type": format === "html" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="qipage-bookmarks.${format}"`,
      "cache-control": "no-store", "x-content-type-options": "nosniff",
    });
    response.end(content);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/admin/bookmarks/import/preview") {
    const input = transferInput(await readJson(request, false, 50_000_000));
    const parsed = input.format === "html" ? parseBookmarksHtml(input.content) : parseCatalogBackup(input.content);
    const catalog = await store.getCatalog();
    const restorePlan = input.restore
      ? planJsonRestore(catalog, parsed, { confirmReplaceNonEmpty: true }) : undefined;
    const preview = restorePlan ? {
      mode: "restore", expectedCounts: restorePlan.expectedCounts,
      expectedHash: restorePlan.expectedHash, replacingNonEmptyCatalog: restorePlan.replacingNonEmptyCatalog,
    } : planBookmarkImport(catalog, parsed);
    json(response, 200, { preview }, corsHeaders);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/admin/bookmarks/import/apply") {
    const expectedVersion = requestVersion(request);
    const input = transferInput(await readJson(request, false, 50_000_000));
    if (!input.confirmed) invalid("Import requires explicit confirmation");
    const parsed = input.format === "html" ? parseBookmarksHtml(input.content) : parseCatalogBackup(input.content);
    const capable = store as CatalogRepository & Pick<CatalogStore, "replaceCatalogWithChangeSet">;
    if (typeof capable.replaceCatalogWithChangeSet !== "function") unavailable("Catalog import is unavailable");
    const result = await serialWrite(async () => {
      const current = await store.getCatalog();
      let next: DashyCatalog;
      let kind: "bookmark_import" | "json_restore";
      if (input.restore === true) {
        if (input.format !== "json") invalid("Only JSON backups can replace a catalog");
        next = planJsonRestore(current, parsed, { confirmReplaceNonEmpty: true }).catalog;
        kind = "json_restore";
      } else {
        const plan = planBookmarkImport(current, parsed);
        next = applyBookmarkImportPlan(current, parsed, plan);
        kind = "bookmark_import";
      }
      return capable.replaceCatalogWithChangeSet(kind, expectedVersion, next);
    });
    const catalog = await store.getCatalog();
    json(response, 200, { catalog, result }, { ...corsHeaders, etag: `"${catalog.version}"` });
    return true;
  }
  return false;
}

function requireHealth(value: HealthJobs | undefined): asserts value is HealthJobs {
  if (!value) unavailable("Health scanning is unavailable");
}
function unavailable(message: string): never { throw new HttpError(503, message, "health_unavailable"); }
function invalid(message: string): never { throw new HttpError(400, message, "invalid_request"); }
function conflict(expectedVersion: string, currentVersion: string): never {
  throw new HttpError(409, "Catalog changed; refresh before writing", "version_conflict", { expectedVersion, currentVersion });
}
function decode(value: string): string { try { return decodeURIComponent(value); } catch { invalid("Route contains invalid URL encoding"); } }
function objectValue(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Request body must be an object");
  return value as Record<string, unknown>;
}
function integer(url: URL, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = url.searchParams.get(name); if (!raw) return fallback;
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${name} is invalid`);
  return value;
}
function transferInput(value: unknown): { format: "html" | "json"; content: string; confirmed: boolean; restore: boolean } {
  const input = objectValue(value);
  if (!['html', 'json'].includes(String(input.format)) || typeof input.content !== "string" || input.content.length > 50_000_000) {
    invalid("format and content are required");
  }
  return { format: input.format as "html" | "json", content: input.content,
    confirmed: input.confirmed === true, restore: input.restore === true };
}
function parseHealthActions(value: unknown): HealthAction[] {
  if (!Array.isArray(value) || value.length > 5_000) invalid("actions must be an array");
  const allowed = new Set(["delete_item", "replace_url", "move_item", "delete_empty_group", "fill_metadata"]);
  for (const row of value) {
    if (!row || typeof row !== "object" || !allowed.has(String((row as { type?: unknown }).type))) invalid("actions contains an invalid action");
    const action = row as Record<string, unknown>;
    if (typeof action.id !== "string" || !action.id.trim() || action.id.length > 200) invalid("action id is invalid");
    if (action.type === "delete_empty_group") {
      requireStrings(action, ["groupId", "expectedName"]);
    } else if (action.type === "delete_item") {
      requireStrings(action, ["itemId", "expectedGroupId", "expectedUrl"]);
    } else if (action.type === "fill_metadata") {
      requireStrings(action, ["itemId", "expectedUrl"]);
      const metadata = action.metadata;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) invalid("metadata must be an object");
      for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
        const limits: Record<string, number> = { title: 300, description: 1000, icon: 4000 };
        if (!limits[key] || typeof value !== "string" || !value.trim() || value.length > limits[key]) invalid("invalid metadata field");
        if (key === "icon" && !/^https?:\/\//i.test(value as string)) invalid("icon must use http or https");
      }
    } else if (action.type === "replace_url") {
      requireStrings(action, ["itemId", "expectedUrl", "url"]);
    } else {
      requireStrings(action, ["itemId", "expectedGroupId", "targetGroupId"]);
    }
  }
  if (new Set(value.map((row) => (row as { id: string }).id)).size !== value.length) invalid("action ids must be unique");
  return structuredClone(value) as HealthAction[];
}
function requireStrings(value: Record<string, unknown>, fields: string[]): void {
  if (fields.some((field) => typeof value[field] !== "string" || !(value[field] as string).trim() || (value[field] as string).length > 4_000)) {
    invalid("action contains a missing or invalid field");
  }
}
