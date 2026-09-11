import { createHash } from "node:crypto";
import { HttpError } from "./errors.js";
import { assertPublicFetchUrl, type LookupAddresses } from "./security.js";
import type { HealthFinding, HealthItemRef, HealthRemoteResult } from "./health-types.js";
import type { DashyCatalog } from "./types.js";

export function catalogItems(catalog: DashyCatalog): HealthItemRef[] {
  return catalog.groups.flatMap((group) => group.items.map((item) => ({
    groupId: group.id, groupName: group.name, itemId: item.id, title: item.title, url: item.url,
    ...(item.localUrl ? { localUrl: item.localUrl } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.tags ? { tags: [...item.tags] } : {}),
  })));
}

export function scanCatalogLocally(catalog: DashyCatalog): HealthFinding[] {
  const items = catalogItems(catalog);
  const findings: HealthFinding[] = [];
  addGrouped(findings, "exact_duplicate", items, ({ url }) => url.trim(), "完全相同的网址");
  addGrouped(findings, "suspected_duplicate", items, ({ url }) => normalizedUrl(url), "规范化后相同的疑似重复网址",
    (group) => new Set(group.map(({ url }) => url.trim())).size > 1);
  addGrouped(findings, "duplicate_title", items, ({ title }) => title.trim().toLocaleLowerCase(), "标题相同的网址");
  for (const item of items) {
    const source = catalog.groups.find(({ id }) => id === item.groupId)?.items.find(({ id }) => id === item.itemId);
    const missing = [!item.title.trim() ? "标题" : "", !source?.description?.trim() ? "介绍" : "",
      !source?.icon?.trim() ? "图标" : ""].filter(Boolean);
    if (missing.length) findings.push({ id: findingId("missing_metadata", [item.itemId]), kind: "missing_metadata",
      message: `缺少${missing.join("、")}`, items: [item] });
  }
  const parentIds = new Set(catalog.groups.map((group) => group.parentId).filter(Boolean));
  for (const group of catalog.groups) {
    if (group.items.length === 0 && !parentIds.has(group.id)) findings.push({ id: findingId("empty_group", [group.id]), kind: "empty_group",
      message: `空分组：${group.name}`, items: [], groupId: group.id });
  }
  return findings;
}

function addGrouped(findings: HealthFinding[], kind: HealthFinding["kind"], items: HealthItemRef[],
  keyFor: (item: HealthItemRef) => string, message: string, include: (items: HealthItemRef[]) => boolean = () => true): void {
  const groups = new Map<string, HealthItemRef[]>();
  for (const item of items) {
    const key = keyFor(item);
    if (key) groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const group of groups.values()) if (group.length > 1 && include(group)) {
    findings.push({ id: findingId(kind, group.map(({ itemId }) => itemId)), kind, message, items: group });
  }
}

export function normalizedUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString();
  } catch { return raw.trim(); }
}

export async function checkRemoteUrl(item: HealthItemRef, options: {
  fetchImpl: typeof fetch; lookup?: LookupAddresses; timeoutMs: number; now?: () => number;
}): Promise<HealthRemoteResult | undefined> {
  let url: URL;
  try { url = new URL(item.url); } catch { return failed(item, "other_error", "网址格式无效", options.now); }
  if (!['http:', 'https:'].includes(url.protocol) || isKnownPrivateHost(url.hostname)) return undefined;
  const started = (options.now ?? Date.now)();
  try {
    await assertPublicFetchUrl(url, options.lookup);
  } catch (error) {
    if (error instanceof HttpError && error.code === "ssrf_target_blocked") return undefined;
    return result(item, "dns_error", started, options.now, { error: "域名解析失败" });
  }
  try {
    let response = await options.fetchImpl(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs),
      headers: { "user-agent": "PersonalNavHealth/1.0" } });
    if (response.status === 405 || response.status === 501) {
      await response.body?.cancel();
      response = await options.fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs),
        headers: { "user-agent": "PersonalNavHealth/1.0", range: "bytes=0-0" } });
    }
    await response.body?.cancel();
    const status = response.status;
    const location = response.headers.get("location") ?? undefined;
    if (status >= 200 && status < 300) return result(item, "ok", started, options.now, { status });
    const redirectDetails = location ? { status, location } : { status };
    if ([301, 308].includes(status)) return result(item, "permanent_redirect", started, options.now, redirectDetails);
    if ([302, 303, 307].includes(status)) return result(item, "temporary_redirect", started, options.now, redirectDetails);
    if ([401, 403].includes(status)) return result(item, "auth_required", started, options.now, { status });
    if ([404, 410].includes(status)) return result(item, "not_found", started, options.now, { status });
    return result(item, "other_error", started, options.now, { status, error: `HTTP ${status}` });
  } catch (error) {
    const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
    const timeout = (error as Error).name === "AbortError" || (error as Error).name === "TimeoutError";
    return result(item, timeout ? "timeout" : code === "ENOTFOUND" || code === "EAI_AGAIN" ? "dns_error" : "other_error",
      started, options.now, { error: timeout ? "请求超时" : code === "ENOTFOUND" || code === "EAI_AGAIN" ? "域名解析失败" : "请求失败" });
  }
}

function isKnownPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    host.endsWith(".internal") || host.endsWith(".ts.net");
}
function result(item: HealthItemRef, category: HealthRemoteResult["category"], started: number,
  now: (() => number) | undefined, details: Partial<HealthRemoteResult>): HealthRemoteResult {
  const ended = (now ?? Date.now)();
  return { item, category, checkedAt: new Date(ended).toISOString(), durationMs: Math.max(0, ended - started), ...details };
}
function failed(item: HealthItemRef, category: HealthRemoteResult["category"], error: string,
  now: (() => number) | undefined): HealthRemoteResult {
  const at = (now ?? Date.now)();
  return { item, category, error, checkedAt: new Date(at).toISOString(), durationMs: 0 };
}
function findingId(kind: string, ids: string[]): string {
  return createHash("sha256").update(`${kind}:${[...ids].sort().join(",")}`).digest("hex").slice(0, 20);
}
