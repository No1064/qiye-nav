import type { IncomingMessage, ServerResponse } from "node:http";
import type { AiClient } from "../ai-client.js";
import { parseAiConfigPatch, type AiConfigStore } from "../ai-config.js";
import {
  parseCreateAiJob,
  parseRetireGroupIds,
  parseSuggestionIds,
  type AiJobs,
} from "../ai-jobs.js";
import { HttpError } from "../errors.js";
import type { AiApplyResult, CatalogRepository, DashyCatalog } from "../types.js";

interface AdminAiRoutesContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  corsHeaders: Record<string, string>;
  aiConfigStore?: AiConfigStore;
  aiJobs?: AiJobs;
  aiClient: AiClient;
  store: CatalogRepository;
  logger: Pick<Console, "info" | "error">;
  readJson: (request: IncomingMessage, optional?: boolean) => Promise<unknown>;
  requestVersion: (request: IncomingMessage) => string;
  serialWrite: <T>(operation: () => Promise<T>) => Promise<T>;
  json: (
    response: ServerResponse,
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ) => void;
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Route contains invalid URL encoding", "invalid_route");
  }
}

function boundedQueryInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, `${name} is invalid`, "invalid_request");
  }
  return parsed;
}

function etag(catalog: DashyCatalog): Record<string, string> {
  return { etag: `"${catalog.version}"` };
}

export async function handleAdminAiRoutes(context: AdminAiRoutesContext): Promise<boolean> {
  const {
    request, response, url, corsHeaders, aiConfigStore, aiJobs, aiClient, store, logger,
    readJson, requestVersion, serialWrite, json,
  } = context;

  if (request.method === "GET" && url.pathname === "/api/v1/admin/ai/config") {
    if (!aiConfigStore) throw new HttpError(503, "AI service is unavailable", "ai_unavailable");
    json(response, 200, await aiConfigStore.publicConfig(), corsHeaders);
    return true;
  }

  if (request.method === "PATCH" && url.pathname === "/api/v1/admin/ai/config") {
    if (!aiConfigStore) throw new HttpError(503, "AI service is unavailable", "ai_unavailable");
    const input = parseAiConfigPatch(await readJson(request));
    json(response, 200, await aiConfigStore.update(input), corsHeaders);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/admin/ai/config/test") {
    if (!aiConfigStore) throw new HttpError(503, "AI service is unavailable", "ai_unavailable");
    json(response, 200, await aiClient.test(await aiConfigStore.requireConfig()), corsHeaders);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/admin/ai/jobs") {
    if (!aiJobs) throw new HttpError(503, "AI service is unavailable", "ai_unavailable");
    const limit = boundedQueryInteger(url.searchParams.get("limit"), 20, 1, 100, "limit");
    const offset = boundedQueryInteger(url.searchParams.get("offset"), 0, 0, 100_000, "offset");
    json(response, 200, await aiJobs.list(limit, offset), corsHeaders);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/admin/ai/jobs") {
    if (!aiJobs) throw new HttpError(503, "AI service is unavailable", "ai_unavailable");
    const job = await aiJobs.create(parseCreateAiJob(await readJson(request)));
    json(response, 202, job, corsHeaders);
    return true;
  }

  const aiJobRoute = url.pathname.match(/^\/api\/v1\/admin\/ai\/jobs\/([^/]+)$/);
  const aiJobLogsRoute = url.pathname.match(/^\/api\/v1\/admin\/ai\/jobs\/([^/]+)\/logs$/);
  const aiJobRetryRoute = url.pathname.match(/^\/api\/v1\/admin\/ai\/jobs\/([^/]+)\/retry$/);
  const aiJobPauseRoute = url.pathname.match(/^\/api\/v1\/admin\/ai\/jobs\/([^/]+)\/pause$/);
  const aiJobResumeRoute = url.pathname.match(/^\/api\/v1\/admin\/ai\/jobs\/([^/]+)\/resume$/);
  const aiJobApplyRoute = url.pathname.match(/^\/api\/v1\/admin\/ai\/jobs\/([^/]+)\/apply$/);
  const aiChangeSetRestoreRoute = url.pathname.match(/^\/api\/v1\/admin\/ai\/change-sets\/([^/]+)\/restore$/);
  if (aiJobRoute && request.method === "GET") {
    if (!aiJobs) throw new HttpError(503, "AI service is unavailable", "ai_unavailable");
    json(response, 200, await aiJobs.get(decodeId(aiJobRoute[1] as string)), corsHeaders);
    return true;
  }
  if (aiJobLogsRoute && request.method === "GET") {
    if (!aiJobs) throw new HttpError(503, "AI service is unavailable", "ai_unavailable");
    const after = boundedQueryInteger(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER, "after");
    json(response, 200, await aiJobs.logs(decodeId(aiJobLogsRoute[1] as string), after), corsHeaders);
    return true;
  }
  if (aiJobRoute && request.method === "DELETE") {
    if (!aiJobs) throw new HttpError(503, "AI service is unavailable", "ai_unavailable");
    await aiJobs.delete(decodeId(aiJobRoute[1] as string));
    response.writeHead(204, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end();
    return true;
  }
  if (aiJobRetryRoute && request.method === "POST") {
    if (!aiJobs) throw new HttpError(503, "AI service is unavailable", "ai_unavailable");
    json(response, 202, await aiJobs.retry(decodeId(aiJobRetryRoute[1] as string)), corsHeaders);
    return true;
  }
  if (aiJobPauseRoute && request.method === "POST") {
    if (!aiJobs) throw new HttpError(503, "AI service is unavailable", "ai_unavailable");
    json(response, 200, await aiJobs.pause(decodeId(aiJobPauseRoute[1] as string)), corsHeaders);
    return true;
  }
  if (aiJobResumeRoute && request.method === "POST") {
    if (!aiJobs) throw new HttpError(503, "AI service is unavailable", "ai_unavailable");
    json(response, 202, await aiJobs.resume(decodeId(aiJobResumeRoute[1] as string)), corsHeaders);
    return true;
  }
  if (aiJobApplyRoute && request.method === "POST") {
    if (!aiJobs) throw new HttpError(503, "AI service is unavailable", "ai_unavailable");
    const jobId = decodeId(aiJobApplyRoute[1] as string);
    const expectedVersion = requestVersion(request);
    const input = await readJson(request, true);
    const suggestionIds = parseSuggestionIds(input);
    const retireGroupIds = aiJobs.retireGroupsToApply(jobId, parseRetireGroupIds(input));
    const suggestions = aiJobs.suggestionsToApply(jobId, suggestionIds);
    const groupPlan = (await aiJobs.get(jobId)).groupPlan;
    const raw = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown> : {};
    const conflictResolutions = parseConflictResolutions(raw.conflictResolutions);
    let applyResult: AiApplyResult | undefined;
    const catalog = await serialWrite(async () => {
      const current = await store.getCatalog();
      if (current.version !== expectedVersion) {
        throw new HttpError(409, "Catalog changed; refresh before applying", "version_conflict", {
          expectedVersion, currentVersion: current.version,
        });
      }
      if (store.applyAiChangeSet) {
        applyResult = await store.applyAiChangeSet(jobId, suggestions, {
            retireEmptyGroupIds: retireGroupIds,
            ...(groupPlan ? { groupPlan } : {}),
            ...(conflictResolutions ? { conflictResolutions } : {}),
          });
      } else {
        await store.applyAiSuggestions(suggestions, {
          retireEmptyGroupIds: retireGroupIds,
          ...(groupPlan ? { groupPlan } : {}),
        });
      }
      const updated = await store.getCatalog();
      logger.info("Admin catalog mutation", { action: "ai.suggestions.apply", version: updated.version });
      return updated;
    });
    const appliedSuggestionIds = applyResult?.appliedSuggestionIds ?? suggestions.map(({ id }) => id);
    if (appliedSuggestionIds.length) await aiJobs.markApplied(jobId, appliedSuggestionIds, applyResult);
    json(response, 200, {
      catalog,
      applied: appliedSuggestionIds.length,
      appliedSuggestionIds,
      ...(applyResult ? { applyResult } : {}),
    }, {
      ...corsHeaders,
      ...etag(catalog),
    });
    return true;
  }

  if (aiChangeSetRestoreRoute && request.method === "POST") {
    if (!store.restoreAiChangeSet) {
      throw new HttpError(503, "Change set restore is unavailable", "ai_unavailable");
    }
    const expectedVersion = requestVersion(request);
    const changeSetId = decodeId(aiChangeSetRestoreRoute[1] as string);
    const restored = await serialWrite(() => store.restoreAiChangeSet!(changeSetId, expectedVersion));
    const catalog = await store.getCatalog();
    logger.info("Admin catalog mutation", { action: "ai.change_set.restore", version: catalog.version });
    json(response, 200, { catalog, restored }, { ...corsHeaders, ...etag(catalog) });
    return true;
  }

  return false;
}

function parseConflictResolutions(
  value: unknown,
): Readonly<Record<string, "keep_current" | "apply_suggestion">> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "conflictResolutions must be an object", "invalid_request");
  }
  const entries = Object.entries(value);
  if (entries.length > 5_000 || entries.some(([id, resolution]) =>
    !id || id.length > 200 || !["keep_current", "apply_suggestion"].includes(String(resolution)))) {
    throw new HttpError(400, "conflictResolutions contains an invalid resolution", "invalid_request");
  }
  return Object.fromEntries(entries) as Readonly<Record<string, "keep_current" | "apply_suggestion">>;
}
