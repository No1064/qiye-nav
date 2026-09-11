import { allowedIconSource, type IconCache } from "./icon-cache.js";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "./errors.js";
import { AdminAuth } from "./admin-auth.js";
import { AiClient } from "./ai-client.js";
import type { AiConfigStore } from "./ai-config.js";
import type { AiJobs } from "./ai-jobs.js";
import { IdempotencyStore } from "./idempotency.js";
import { ImportSessions } from "./import-sessions.js";
import type { HealthJobs } from "./health-jobs.js";
import { handleAdminAiRoutes } from "./routes/admin-ai-routes.js";
import { handlePublicRoutes } from "./routes/public-routes.js";
import { handleAgentRoutes } from "./routes/agent-routes.js";
import { handleAdminHealthRoutes } from "./routes/admin-health-routes.js";
import { fallbackTitle, normalizeBookmarkUrl, normalizeUrl } from "./url.js";
import {
  parseAdminItemCreate,
  parseAdminItemPatch,
  parseGroupCreate,
  parseGroupDelete,
  parseGroupPatch,
  parseMetadataPreview,
  parseMoveItem,
  parseBulkMoveItems,
  parseOrder,
  parseSettingsPatch,
  type AdminItemInput,
  type AdminItemPatchInput,
} from "./validation.js";
import type {
  AppConfig,
  BookmarkInput,
  CatalogGroup,
  CatalogItem,
  CatalogRepository,
  DashyCatalog,
  DashyItem,
  HttpResult,
  ItemPatch,
  Metadata,
} from "./types.js";
import { NavAgent } from "./nav-agent.js";

const MAX_JSON_BYTES = 1024 * 1024;
const DEFAULT_MANAGE_DIR = fileURLToPath(new URL("../public/manage/", import.meta.url));
const DEFAULT_HOME_DIR = fileURLToPath(new URL("../public/home/", import.meta.url));
// Static surfaces intentionally avoid CSP and COOP. Browser assistants and
// annotation tools inject isolated overlays into ordinary pages; those headers can
// block their frames or cross-context messaging. CSRF, auth, nosniff, no-store,
// and framing protection still apply via the app routes and the headers below.
const BROWSER_OVERLAY_SAFE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export interface AppDependencies {
  config: AppConfig;
  store: CatalogRepository;
  fetchMetadata: (url: string) => Promise<Metadata>;
  manageDir?: string;
  homeDir?: string;
  logger?: Pick<Console, "info" | "error">;
  adminAuth?: AdminAuth;
  iconCache?: IconCache;
  saveAdminPasswordHash?: (hash: string) => Promise<void>;
  aiConfigStore?: AiConfigStore;
  aiJobs?: AiJobs;
  aiClient?: AiClient;
  importSessions?: ImportSessions;
  healthJobs?: HealthJobs;
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function hasValidBearer(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function requireAuth(request: IncomingMessage, expected: string): void {
  if (!hasValidBearer(request, expected)) {
    throw new HttpError(401, "A valid Bearer token is required", "unauthorized");
  }
}

function loginInput(value: unknown): { username: string; password: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object", "invalid_request");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.username !== "string" ||
    !input.username.trim() ||
    input.username.length > 200 ||
    typeof input.password !== "string" ||
    input.password.length > 1_024
  ) {
    throw new HttpError(400, "username and password are required", "invalid_request");
  }
  return { username: input.username.trim(), password: input.password };
}

function clientKey(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(",")[0]?.trim() || request.socket.remoteAddress || "unknown";
}

async function readJson(request: IncomingMessage, optional = false, maximumBytes = MAX_JSON_BYTES): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) {
      throw new HttpError(413, "Request body is too large", "request_too_large");
    }
    chunks.push(buffer);
  }
  if (size === 0 && optional) return undefined;
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json", "unsupported_media_type");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON", "invalid_json");
  }
}

function idempotencyKey(request: IncomingMessage): string {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.length > 200 || /[^\x21-\x7e]/.test(value)) {
    throw new HttpError(
      400,
      "Idempotency-Key must be a non-empty printable ASCII value up to 200 characters",
      "invalid_idempotency_key",
    );
  }
  return value;
}

function requestVersion(request: IncomingMessage): string {
  const rawHeader = request.headers["if-match"];
  const raw = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader)?.trim();
  if (!raw) {
    throw new HttpError(428, "If-Match with the current catalog version is required", "version_required");
  }
  const value = raw
    .replace(/^W\//, "")
    .replace(/^"|"$/g, "")
    // Caddy adds the selected content-encoding to proxied ETags. A client must
    // be able to send that exact response header back as If-Match.
    .replace(/-(?:gzip|zstd)$/i, "");
  if (!/^[a-f\d]{64}$/i.test(value)) {
    throw new HttpError(400, "If-Match is not a valid catalog version", "invalid_version");
  }
  return value.toLowerCase();
}

function allowedCorsHeaders(origin: string | undefined, config: AppConfig): Record<string, string> {
  if (!origin) return {};
  if (!config.corsAllowedOrigins.has("*") && !config.corsAllowedOrigins.has(origin)) return {};
  return {
    "access-control-allow-origin": config.corsAllowedOrigins.has("*") ? "*" : origin,
    "access-control-expose-headers": "ETag",
    vary: "Origin",
  };
}

function metadataFailure(error: unknown): { status: "failed"; code: string } {
  return {
    status: "failed",
    code: error instanceof HttpError ? error.code : "metadata_fetch_failed",
  };
}

function etag(catalog: DashyCatalog): Record<string, string> {
  return { etag: `"${catalog.version}"` };
}

function findGroup(catalog: DashyCatalog, groupId: string): CatalogGroup {
  const group = catalog.groups.find((candidate) => candidate.id === groupId);
  if (!group) throw new HttpError(404, `Group '${groupId}' does not exist`, "group_not_found");
  return group;
}

function findItem(group: CatalogGroup, itemId: string): CatalogItem {
  const item = group.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new HttpError(404, `Item '${itemId}' does not exist`, "item_not_found");
  return item;
}

function normalizedItemUrls(item: Pick<DashyItem, "url" | "localUrl">): string[] {
  return [item.url, item.localUrl]
    .filter((url): url is string => !!url)
    .map((url) => normalizeUrl(url));
}

function assertNoDuplicate(
  catalog: DashyCatalog,
  item: Pick<DashyItem, "url" | "localUrl">,
  exclude?: { groupId: string; itemId: string },
): void {
  const wanted = new Set(normalizedItemUrls(item));
  for (const group of catalog.groups) {
    for (const candidate of group.items) {
      if (exclude?.groupId === group.id && exclude.itemId === candidate.id) continue;
      if (normalizedItemUrls(candidate).some((url) => wanted.has(url))) {
        throw new HttpError(409, "The URL already exists in the catalog", "duplicate_url", {
          groupId: group.id,
          itemId: candidate.id,
        });
      }
    }
  }
}

function createAdminItem(input: AdminItemInput, allowLocalUrls: boolean): DashyItem {
  if (input.localUrl && !allowLocalUrls) {
    throw new HttpError(400, "localUrl is disabled on this server", "local_url_disabled");
  }
  const remoteUrl = input.remoteUrl
    ? normalizeBookmarkUrl(input.remoteUrl, "remoteUrl")
    : input.url
      ? normalizeBookmarkUrl(input.url, "url")
      : undefined;
  const localUrl = input.localUrl ? normalizeBookmarkUrl(input.localUrl, "localUrl") : undefined;
  const url = remoteUrl ?? localUrl;
  if (!url) throw new HttpError(400, "A URL is required", "missing_url");
  return {
    title: input.title ?? fallbackTitle(url),
    url,
    ...(localUrl ? { localUrl } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.icon ? { icon: input.icon } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
  };
}

function updateAdminItem(
  current: CatalogItem,
  input: AdminItemPatchInput,
  allowLocalUrls: boolean,
): { item: DashyItem; patch: ItemPatch } {
  if (input.localUrl && !allowLocalUrls) {
    throw new HttpError(400, "localUrl is disabled on this server", "local_url_disabled");
  }
  const nextUrl = input.remoteUrl ?? input.url;
  const url = nextUrl === undefined ? current.url : normalizeBookmarkUrl(nextUrl, "url");
  const localUrl = input.localUrl === undefined
    ? current.localUrl
    : input.localUrl === null
      ? undefined
      : normalizeBookmarkUrl(input.localUrl, "localUrl");
  const description = input.description === undefined
    ? current.description
    : input.description === null
      ? undefined
      : input.description;
  const icon = input.icon === undefined
    ? current.icon
    : input.icon === null
      ? undefined
      : input.icon;
  const tags = input.tags === undefined ? current.tags : input.tags === null ? undefined : input.tags;
  const item: DashyItem = {
    title: input.title ?? current.title,
    url,
    ...(localUrl ? { localUrl } : {}),
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(tags ? { tags } : {}),
  };
  const patch: ItemPatch = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(nextUrl !== undefined ? { url } : {}),
    ...(input.localUrl !== undefined ? { localUrl: localUrl ?? null } : {}),
    ...(input.description !== undefined ? { description: description ?? null } : {}),
    ...(input.icon !== undefined ? { icon: icon ?? null } : {}),
    ...(input.tags !== undefined ? { tags: tags ?? null } : {}),
  };
  return { item, patch };
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Route contains invalid URL encoding", "invalid_route");
  }
}

async function serveManage(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  manageDir: string,
): Promise<boolean> {
  if (pathname === "/manage") {
    response.writeHead(308, { location: "/manage/", ...BROWSER_OVERLAY_SAFE_HEADERS });
    response.end();
    return true;
  }
  if (!pathname.startsWith("/manage/")) return false;
  const relativePath = decodeStaticPath(pathname.slice("/manage/".length)) || "index.html";
  await serveStaticFile(request, response, relativePath, manageDir);
  return true;
}

function serveStart(response: ServerResponse, pathname: string): boolean {
  if (pathname !== "/start" && !pathname.startsWith("/start/")) return false;
  response.writeHead(308, { location: "/", ...BROWSER_OVERLAY_SAFE_HEADERS });
  response.end();
  return true;
}

function decodeStaticPath(value: string): string {
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Static path contains invalid encoding", "invalid_static_path");
  }
  if (
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((part) => part === "..")
  ) {
    throw new HttpError(400, "Invalid static path", "invalid_static_path");
  }
  return relativePath;
}

async function serveStaticFile(
  request: IncomingMessage,
  response: ServerResponse,
  relativePath: string,
  directory: string,
  headers: Readonly<Record<string, string>> = BROWSER_OVERLAY_SAFE_HEADERS,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError(405, "Static resources only support GET and HEAD", "method_not_allowed");
  }
  const root = resolve(directory);
  const filePath = resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    throw new HttpError(400, "Invalid static path", "invalid_static_path");
  }
  let content: Buffer;
  try {
    content = await readFile(filePath);
  } catch (error) {
    if (["EISDIR", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new HttpError(404, "Static resource not found", "not_found");
    }
    throw error;
  }
  response.writeHead(200, {
    ...headers,
    "content-type": CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(content.byteLength),
  });
  response.end(request.method === "HEAD" ? undefined : content);
}

async function serveHome(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  homeDir: string,
): Promise<boolean> {
  if (pathname.startsWith("/api/") || pathname.startsWith("/manage")) return false;
  const relativePath = decodeStaticPath(pathname.slice(1)) || "index.html";
  await serveStaticFile(request, response, relativePath, homeDir, BROWSER_OVERLAY_SAFE_HEADERS);
  return true;
}

export function createApp(dependencies: AppDependencies): RequestListener {
  const { config, store, fetchMetadata } = dependencies;
  const logger = dependencies.logger ?? console;
  const manageDir = dependencies.manageDir ?? DEFAULT_MANAGE_DIR;
  const homeDir = dependencies.homeDir ?? DEFAULT_HOME_DIR;
  const idempotency = new IdempotencyStore(config.idempotencyTtlMs);
  const adminAuth = dependencies.adminAuth ?? new AdminAuth({
    username: config.adminUsername,
    passwordHash: config.adminPasswordHash,
    cookieSecure: config.adminCookieSecure,
  });
  const aiConfigStore = dependencies.aiConfigStore;
  const aiJobs = dependencies.aiJobs;
  const aiClient = dependencies.aiClient ?? new AiClient();
  const navAgent = aiConfigStore ? new NavAgent(store, aiConfigStore, aiClient) : undefined;
  const importSessions = dependencies.importSessions ?? new ImportSessions();
  const healthJobs = dependencies.healthJobs;
  let writeQueue: Promise<void> = Promise.resolve();

  function serialWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function checkedWrite(
    expectedVersion: string,
    action: string,
    operation: (catalog: DashyCatalog) => Promise<void>,
  ): Promise<DashyCatalog> {
    return serialWrite(async () => {
      const current = await store.getCatalog();
      if (current.version !== expectedVersion) {
        throw new HttpError(409, "Catalog changed; refresh before writing", "version_conflict", {
          expectedVersion,
          currentVersion: current.version,
        });
      }
      await operation(current);
      const updated = await store.getCatalog();
      logger.info("Admin catalog mutation", { action, version: updated.version });
      return updated;
    });
  }

  async function createBookmark(input: BookmarkInput): Promise<HttpResult> {
    if (input.localUrl && !config.allowLocalUrls) {
      throw new HttpError(400, "localUrl is disabled on this server", "local_url_disabled");
    }
    const remoteUrl = input.remoteUrl
      ? normalizeBookmarkUrl(input.remoteUrl, "remoteUrl")
      : input.url
        ? normalizeBookmarkUrl(input.url, "url")
        : undefined;
    const localUrl = input.localUrl ? normalizeBookmarkUrl(input.localUrl, "localUrl") : undefined;
    const itemUrl = remoteUrl ?? localUrl;
    if (!itemUrl) throw new HttpError(400, "A URL is required", "missing_url");

    const normalizedUrls = new Set(
      [remoteUrl, localUrl]
        .filter((url): url is string => !!url)
        .map((url) => normalizeUrl(url)),
    );
    const duplicate = await store.findDuplicate(normalizedUrls);
    if (duplicate) {
      return {
        status: 200,
        body: {
          duplicate: true,
          bookmark: duplicate.item,
          group: { id: duplicate.groupId, name: duplicate.groupName },
          itemId: duplicate.itemId,
          normalizedUrl: itemUrl,
        },
      };
    }

    const shouldFetch = !!remoteUrl && remoteUrl !== localUrl;
    let metadata: Metadata | undefined;
    let metadataStatus:
      | { status: "complete" }
      | { status: "skipped"; code?: string }
      | { status: "failed"; code: string };
    if (shouldFetch) {
      try {
        metadata = await fetchMetadata(remoteUrl);
        metadataStatus = { status: "complete" };
      } catch (error) {
        metadataStatus = error instanceof HttpError && error.code === "ssrf_target_blocked"
          ? { status: "skipped", code: "private_url" }
          : metadataFailure(error);
      }
    } else {
      metadataStatus = { status: "skipped" };
    }

    const description = input.description ?? metadata?.description;
    const icon = input.icon ?? metadata?.favicon;
    const item: DashyItem = {
      title: input.title ?? metadata?.title ?? fallbackTitle(itemUrl),
      url: itemUrl,
      ...(description ? { description } : {}),
      ...(icon ? { icon } : {}),
      ...(localUrl ? { localUrl } : {}),
    };
    const created = await store.addBookmark(input.groupId, item);
    return {
      status: 201,
      body: {
        duplicate: false,
        bookmark: item,
        group: created.group,
        normalizedUrl: itemUrl,
        metadata: metadataStatus,
        source: input.source ?? "api",
        trigger: input.trigger ?? "manual",
      },
    };
  }

  const listener: RequestListener = (request, response) => {
    void (async () => {
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      const corsHeaders = allowedCorsHeaders(origin, config);
      const url = new URL(request.url ?? "/", "http://ingest.local");

      if (request.method === "OPTIONS") {
        if (origin && Object.keys(corsHeaders).length === 0) {
          throw new HttpError(403, "Origin is not allowed", "cors_origin_forbidden");
        }
        response.writeHead(204, {
          ...corsHeaders,
          "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
          "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key, If-Match, X-CSRF-Token",
          "access-control-max-age": "600",
        });
        response.end();
        return;
      }

      if (await handleAgentRoutes({
        request, response, url, corsHeaders, ingestToken: config.ingestToken,
        requireAuth, readJson, json,
        ...(navAgent ? { agent: navAgent } : {}),
      })) return;

      if (await handlePublicRoutes({
        request,
        response,
        url,
        corsHeaders,
        config,
        store,
        idempotency,
        importSessions,
        requireAuth,
        readJson,
        idempotencyKey,
        serialWrite,
        createBookmark,
        json,
        ...(healthJobs ? { healthJobs } : {}),
      })) return;

      const iconRoute = url.pathname.match(/^\/api\/v1\/icons\/([^/]+)$/);
      if (request.method === "GET" && iconRoute) {
        if (!dependencies.iconCache) throw new HttpError(404, "Icon cache unavailable", "not_found");
        const source = url.searchParams.get("source") || "";
        const catalog = await store.getCatalog();
        const item = catalog.groups.flatMap((group) => group.items).find((entry) => entry.id === decodeURIComponent(iconRoute[1]!));
        if (!item || source.length > 4000 || !allowedIconSource(item, source)) throw new HttpError(400, "Invalid icon source", "invalid_request");
        const icon = await dependencies.iconCache.get(source);
        response.writeHead(200, { "content-type": icon.mime, "cache-control": "public, max-age=604800", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'", "cross-origin-resource-policy": "cross-origin" });
        response.end(Buffer.from(icon.data, "base64"));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/v1/admin/auth/login") {
        adminAuth.requireLoginOrigin(request);
        const input = loginInput(await readJson(request));
        const result = await adminAuth.login(input.username, input.password, clientKey(request));
        json(response, 200, adminAuth.response(result.session), {
          "set-cookie": result.cookie as string,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/admin/auth/session") {
        const session = adminAuth.requireSession(request);
        json(response, 200, adminAuth.response(session));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/v1/admin/auth/logout") {
        const session = adminAuth.requireSession(request);
        adminAuth.requireMutation(request, session);
        const cookie = adminAuth.logout(request);
        response.writeHead(204, {
          "cache-control": "no-store",
          "set-cookie": cookie,
          "x-content-type-options": "nosniff",
        });
        response.end();
        return;
      }

      if (url.pathname.startsWith("/api/v1/admin/")) {
        const session = adminAuth.requireSession(request);
        if (!["GET", "HEAD"].includes(request.method ?? "")) {
          adminAuth.requireMutation(request, session);
        }
      }

      if (request.method === "POST" && url.pathname === "/api/v1/admin/auth/password") {
        const input = await readJson(request) as Record<string, unknown>;
        if (!input || typeof input.currentPassword !== "string" || typeof input.newPassword !== "string" || input.currentPassword.length > 1024 || input.newPassword.length > 1024) throw new HttpError(400, "Current and new passwords are required", "invalid_request");
        if (!dependencies.saveAdminPasswordHash) throw new HttpError(503, "Password storage is unavailable", "password_storage_unavailable");
        await serialWrite(async () => {
          adminAuth.requireSession(request);
          await adminAuth.changePassword(input.currentPassword as string, input.newPassword as string, clientKey(request), dependencies.saveAdminPasswordHash!);
        });
        json(response, 200, { changed: true }, { "set-cookie": adminAuth.logout(request) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/admin/catalog") {
        const catalog = await store.getCatalog();
        json(response, 200, catalog, { ...corsHeaders, ...etag(catalog) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/admin/settings") {
        const catalog = await store.getCatalog();
        json(
          response,
          200,
          { version: catalog.version, settings: catalog.settings },
          { ...corsHeaders, ...etag(catalog) },
        );
        return;
      }

      if (request.method === "PATCH" && url.pathname === "/api/v1/admin/settings") {
        const expected = requestVersion(request);
        const input = parseSettingsPatch(await readJson(request));
        const catalog = await checkedWrite(expected, "settings.update", async () => {
          await store.updateSettings(input);
        });
        json(response, 200, catalog, { ...corsHeaders, ...etag(catalog) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/v1/admin/metadata/preview") {
        const input = parseMetadataPreview(await readJson(request));
        const normalizedUrl = normalizeUrl(input.url);
        const metadata = await fetchMetadata(normalizedUrl);
        json(
          response,
          200,
          {
            url: normalizedUrl,
            finalUrl: metadata.finalUrl,
            ...(metadata.title ? { title: metadata.title } : {}),
            ...(metadata.description ? { description: metadata.description } : {}),
            ...(metadata.favicon ? { icon: metadata.favicon } : {}),
          },
          corsHeaders,
        );
        return;
      }

      if (await handleAdminAiRoutes({
        request,
        response,
        url,
        corsHeaders,
        ...(aiConfigStore ? { aiConfigStore } : {}),
        ...(aiJobs ? { aiJobs } : {}),
        aiClient,
        store,
        logger,
        readJson,
        requestVersion,
        serialWrite,
        json,
      })) return;

      if (await handleAdminHealthRoutes({
        request, response, url, corsHeaders, store, ...(healthJobs ? { healthJobs } : {}), logger,
        readJson, requestVersion, serialWrite, json,
      })) return;

      if (request.method === "POST" && url.pathname === "/api/v1/admin/groups") {
        const expected = requestVersion(request);
        const input = parseGroupCreate(await readJson(request));
        const catalog = await checkedWrite(expected, "group.create", async (current) => {
          if (input.parentId) findGroup(current, input.parentId);
          if (current.groups.some((group) => group.parentId === input.parentId && group.name.toLowerCase() === input.name.toLowerCase())) {
            throw new HttpError(409, "A group with this name already exists", "duplicate_group");
          }
          await store.createGroup(input);
        });
        json(response, 201, catalog, { ...corsHeaders, ...etag(catalog) });
        return;
      }

      const groupRoute = url.pathname.match(/^\/api\/v1\/admin\/groups\/([^/]+)$/);
      if (groupRoute && request.method === "PATCH") {
        const groupId = decodeId(groupRoute[1] as string);
        const expected = requestVersion(request);
        const input = parseGroupPatch(await readJson(request));
        const catalog = await checkedWrite(expected, "group.update", async (current) => {
          findGroup(current, groupId);
          const currentGroup = findGroup(current, groupId);
          const nextParentId = input.parentId === null ? undefined : input.parentId ?? currentGroup.parentId;
          if (nextParentId) findGroup(current, nextParentId);
          if (
            input.name &&
            current.groups.some(
              (group) => group.id !== groupId && group.parentId === nextParentId && group.name.toLowerCase() === input.name?.toLowerCase(),
            )
          ) {
            throw new HttpError(409, "A group with this name already exists", "duplicate_group");
          }
          await store.updateGroup(groupId, input);
        });
        json(response, 200, catalog, { ...corsHeaders, ...etag(catalog) });
        return;
      }

      if (groupRoute && request.method === "DELETE") {
        const groupId = decodeId(groupRoute[1] as string);
        const expected = requestVersion(request);
        const options = parseGroupDelete(await readJson(request, true));
        const catalog = await checkedWrite(expected, "group.delete", async (current) => {
          findGroup(current, groupId);
          if (options.moveItemsToGroupId) findGroup(current, options.moveItemsToGroupId);
          await store.deleteGroup(groupId, options);
        });
        json(response, 200, catalog, { ...corsHeaders, ...etag(catalog) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/v1/admin/items") {
        const expected = requestVersion(request);
        const input = parseAdminItemCreate(await readJson(request));
        const catalog = await checkedWrite(expected, "item.create", async (current) => {
          findGroup(current, input.groupId);
          const item = createAdminItem(input, config.allowLocalUrls);
          assertNoDuplicate(current, item);
          await store.createItem(input.groupId, item);
        });
        json(response, 201, catalog, { ...corsHeaders, ...etag(catalog) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/v1/admin/items/move") {
        const expected = requestVersion(request);
        const input = parseBulkMoveItems(await readJson(request));
        const catalog = await checkedWrite(expected, "items.move", async (current) => {
          findGroup(current, input.targetGroupId);
          for (const reference of input.items) {
            findItem(findGroup(current, reference.groupId), reference.itemId);
          }
          await store.moveItems(input.items, input.targetGroupId, input.targetIndex);
        });
        json(response, 200, catalog, { ...corsHeaders, ...etag(catalog) });
        return;
      }

      const itemRoute = url.pathname.match(
        /^\/api\/v1\/admin\/groups\/([^/]+)\/items\/([^/]+)$/,
      );
      const moveRoute = url.pathname.match(
        /^\/api\/v1\/admin\/groups\/([^/]+)\/items\/([^/]+)\/move$/,
      );

      if (moveRoute && request.method === "POST") {
        const groupId = decodeId(moveRoute[1] as string);
        const itemId = decodeId(moveRoute[2] as string);
        const expected = requestVersion(request);
        const input = parseMoveItem(await readJson(request));
        const catalog = await checkedWrite(expected, "item.move", async (current) => {
          findItem(findGroup(current, groupId), itemId);
          findGroup(current, input.targetGroupId);
          await store.moveItem(
            groupId,
            itemId,
            input.targetGroupId,
            input.targetIndex,
          );
        });
        json(response, 200, catalog, { ...corsHeaders, ...etag(catalog) });
        return;
      }

      if (itemRoute && request.method === "PATCH") {
        const groupId = decodeId(itemRoute[1] as string);
        const itemId = decodeId(itemRoute[2] as string);
        const expected = requestVersion(request);
        const input = parseAdminItemPatch(await readJson(request));
        const catalog = await checkedWrite(expected, "item.update", async (current) => {
          const item = findItem(findGroup(current, groupId), itemId);
          const updated = updateAdminItem(item, input, config.allowLocalUrls);
          assertNoDuplicate(current, updated.item, { groupId, itemId });
          await store.updateItem(groupId, itemId, updated.patch);
        });
        json(response, 200, catalog, { ...corsHeaders, ...etag(catalog) });
        return;
      }

      if (itemRoute && request.method === "DELETE") {
        const groupId = decodeId(itemRoute[1] as string);
        const itemId = decodeId(itemRoute[2] as string);
        const expected = requestVersion(request);
        const catalog = await checkedWrite(expected, "item.delete", async (current) => {
          findItem(findGroup(current, groupId), itemId);
          await store.deleteItem(groupId, itemId);
        });
        json(response, 200, catalog, { ...corsHeaders, ...etag(catalog) });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/v1/admin/order") {
        const expected = requestVersion(request);
        const input = parseOrder(await readJson(request));
        const catalog = await checkedWrite(expected, `${input.scope}.order`, async (current) => {
          if (input.scope === "groups") {
            await store.orderGroups(input.groupIds);
          } else {
            findGroup(current, input.groupId);
            await store.orderItems(input.groupId, input.itemIds);
          }
        });
        json(response, 200, catalog, { ...corsHeaders, ...etag(catalog) });
        return;
      }

      if (await serveManage(request, response, url.pathname, manageDir)) return;
      if (serveStart(response, url.pathname)) return;
      if (await serveHome(request, response, url.pathname, homeDir)) return;
      throw new HttpError(404, "Route not found", "not_found");
    })().catch((error: unknown) => {
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      const corsHeaders = allowedCorsHeaders(origin, config);
      const known = error instanceof HttpError;
      if (!known) logger.error("Unhandled request error", error);
      const status = known ? error.status : 500;
      json(
        response,
        status,
        {
          error: {
            code: known ? error.code : "internal_error",
            message: known ? error.message : "Internal server error",
            ...(known && error.details !== undefined ? { details: error.details } : {}),
          },
        },
        {
          ...corsHeaders,
          ...(status === 401 && !request.url?.startsWith("/api/v1/admin/")
            ? { "www-authenticate": 'Bearer realm="nav-ingest"' }
            : {}),
          ...(status === 429 && known && typeof error.details === "object" && error.details !== null
            ? {
                "retry-after": String(
                  (error.details as { retryAfterSeconds?: number }).retryAfterSeconds ?? 60,
                ),
              }
            : {}),
        },
      );
    });
  };
  return listener;
}
