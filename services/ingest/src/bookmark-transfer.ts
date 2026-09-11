import { randomUUID } from "node:crypto";
import { computeCatalogVersion, normalizeCatalog } from "./catalog-schema.js";
import { normalizeUrl } from "./url.js";
import type { CatalogItem, CatalogSettings, DashyCatalog, DashyItem } from "./types.js";

const BACKUP_FORMAT = "qipage-catalog-backup" as const;
const BACKUP_VERSION = 1 as const;

export interface BookmarkTransferGroup {
  key: string;
  name: string;
  parentKey?: string;
  icon?: string;
  stableId?: string;
}

export interface BookmarkTransferItem extends DashyItem {
  groupKey: string;
  stableId?: string;
}

export interface ParsedBookmarkTransfer {
  format: "html" | "json";
  groups: BookmarkTransferGroup[];
  items: BookmarkTransferItem[];
  settings?: CatalogSettings;
  backup?: CatalogBackup;
}

export interface CatalogBackup {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_VERSION;
  exportedAt: string;
  counts: { groups: number; items: number };
  hash: string;
  catalog: DashyCatalog;
}

export interface ImportConflict {
  normalizedUrl: string;
  imported: BookmarkTransferItem;
  existing: { groupId: string; item: CatalogItem };
  fields: Array<"title" | "group" | "localUrl" | "description" | "icon" | "tags">;
}

export interface BookmarkImportPlan {
  format: ParsedBookmarkTransfer["format"];
  counts: {
    sourceGroups: number;
    sourceItems: number;
    newGroups: number;
    newItems: number;
    duplicates: number;
    conflicts: number;
  };
  createGroups: BookmarkTransferGroup[];
  createItems: BookmarkTransferItem[];
  duplicates: Array<{ normalizedUrl: string; imported: BookmarkTransferItem }>;
  conflicts: ImportConflict[];
}

export interface JsonRestorePlan {
  catalog: DashyCatalog;
  expectedCounts: CatalogBackup["counts"];
  expectedHash: string;
  replacingNonEmptyCatalog: boolean;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function decodeHtml(value: string): string {
  return value.replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, "")).trim();
}

function itemCount(catalog: DashyCatalog): number {
  return catalog.groups.reduce((sum, group) => sum + group.items.length, 0);
}

function groupKey(parentKey: string | undefined, name: string, index: number): string {
  return `${parentKey ?? "root"}/${index}:${name}`;
}

/** Export a standards-compatible Netscape Bookmark file with at most two folder levels. */
export function exportBookmarksHtml(catalog: DashyCatalog): string {
  const children = new Map<string, typeof catalog.groups>();
  for (const group of catalog.groups) {
    if (group.parentId) {
      const list = children.get(group.parentId) ?? [];
      list.push(group);
      children.set(group.parentId, list);
    }
  }
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    `<TITLE>${escapeHtml(catalog.settings.title)}</TITLE>`,
    `<H1>${escapeHtml(catalog.settings.title)}</H1>`,
    "<DL><p>",
  ];
  const appendItem = (item: CatalogItem, indent: string) => {
    lines.push(`${indent}<DT><A HREF="${escapeHtml(item.url)}">${escapeHtml(item.title)}</A>`);
  };
  const appendGroup = (group: (typeof catalog.groups)[number], indent: string) => {
    lines.push(`${indent}<DT><H3>${escapeHtml(group.name)}</H3>`, `${indent}<DL><p>`);
    for (const item of group.items) appendItem(item, `${indent}    `);
    for (const child of children.get(group.id) ?? []) {
      appendGroup(child, `${indent}    `);
    }
    lines.push(`${indent}</DL><p>`);
  };
  for (const group of catalog.groups) {
    if (!group.parentId) appendGroup(group, "    ");
  }
  lines.push("</DL><p>", "");
  return lines.join("\n");
}

/** Create a self-verifying, complete JSON backup. */
export function createCatalogBackup(catalog: DashyCatalog, exportedAt = new Date().toISOString()): CatalogBackup {
  // Normalize first so semantically identical input cannot produce a different
  // hash merely because object properties were inserted in another order.
  const copy = normalizeCatalog(structuredClone(catalog));
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    exportedAt,
    counts: { groups: copy.groups.length, items: itemCount(copy) },
    hash: computeCatalogVersion(copy),
    catalog: copy,
  };
}

export function exportCatalogJson(catalog: DashyCatalog, exportedAt?: string): string {
  return `${JSON.stringify(createCatalogBackup(catalog, exportedAt), null, 2)}\n`;
}

/** Parse folders and links from Netscape/Chrome bookmark HTML without writing anything. */
export function parseBookmarksHtml(html: string): ParsedBookmarkTransfer {
  if (typeof html !== "string" || html.length === 0 || html.length > 50_000_000) {
    throw new Error("Bookmark HTML must be a non-empty string up to 50 MB");
  }
  const groups: BookmarkTransferGroup[] = [];
  const items: BookmarkTransferItem[] = [];
  const stack: string[] = [];
  let pendingGroup: string | undefined;
  const tokens = html.match(/<H3\b[^>]*>[\s\S]*?<\/H3\s*>|<A\b[^>]*>[\s\S]*?<\/A\s*>|<DL\b[^>]*>|<\/DL\s*>/gi) ?? [];
  for (const token of tokens) {
    if (/^<H3\b/i.test(token)) {
      const name = stripTags(token.replace(/^<H3\b[^>]*>/i, "").replace(/<\/H3\s*>$/i, ""));
      if (!name) throw new Error("Bookmark folder name must not be empty");
      const parentKey = stack.at(-1);
      const key = groupKey(parentKey, name, groups.length);
      groups.push({ key, name, ...(parentKey ? { parentKey } : {}) });
      pendingGroup = key;
      continue;
    }
    if (/^<DL\b/i.test(token)) {
      if (pendingGroup) stack.push(pendingGroup);
      pendingGroup = undefined;
      continue;
    }
    if (/^<\/DL/i.test(token)) {
      stack.pop();
      pendingGroup = undefined;
      continue;
    }
    const href = /\bHREF\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(token);
    if (!href) continue;
    const rawUrl = decodeHtml(href[1] ?? href[2] ?? href[3] ?? "");
    const url = normalizeUrl(rawUrl, "bookmark href");
    const title = stripTags(token.replace(/^<A\b[^>]*>/i, "").replace(/<\/A\s*>$/i, "")) || new URL(url).hostname;
    const currentGroup = stack.at(-1);
    if (!currentGroup) {
      const root = groups.find((group) => group.key === "root/unfiled") ?? { key: "root/unfiled", name: "未分类" };
      if (!groups.includes(root)) groups.unshift(root);
      items.push({ groupKey: root.key, title, url });
    } else {
      items.push({ groupKey: currentGroup, title, url });
    }
  }
  if (items.length === 0) throw new Error("Bookmark HTML contains no valid links");
  return { format: "html", groups, items };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse and verify a native JSON backup, including stable IDs, counts, and content hash. */
export function parseCatalogBackup(input: string | unknown): ParsedBookmarkTransfer {
  const raw: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (!isRecord(raw) || raw.format !== BACKUP_FORMAT || raw.formatVersion !== BACKUP_VERSION || !isRecord(raw.counts)) {
    throw new Error("Unsupported catalog backup format");
  }
  const catalog = normalizeCatalog(raw.catalog);
  const counts = { groups: catalog.groups.length, items: itemCount(catalog) };
  if (raw.counts.groups !== counts.groups || raw.counts.items !== counts.items) {
    throw new Error("Catalog backup count verification failed");
  }
  const hash = computeCatalogVersion(catalog);
  if (raw.hash !== hash) throw new Error("Catalog backup hash verification failed");
  const backup: CatalogBackup = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
    counts,
    hash,
    catalog,
  };
  const groups = catalog.groups.map((group): BookmarkTransferGroup => ({
    key: group.id,
    stableId: group.id,
    name: group.name,
    ...(group.parentId ? { parentKey: group.parentId } : {}),
    ...(group.icon ? { icon: group.icon } : {}),
  }));
  const items = catalog.groups.flatMap((group) => group.items.map((item): BookmarkTransferItem => ({
    groupKey: group.id,
    stableId: item.id,
    title: item.title,
    url: item.url,
    ...(item.localUrl ? { localUrl: item.localUrl } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.tags ? { tags: [...item.tags] } : {}),
  })));
  return { format: "json", groups, items, settings: catalog.settings, backup };
}

function normalizedAddresses(item: Pick<DashyItem, "url" | "localUrl">): string[] {
  return [item.url, item.localUrl].filter((value): value is string => Boolean(value)).map((value) => normalizeUrl(value));
}

function equalTags(left?: string[], right?: string[]): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

/** Build a dry-run/incremental plan. Existing or earlier source URLs are never scheduled twice. */
export function planBookmarkImport(catalog: DashyCatalog, parsed: ParsedBookmarkTransfer): BookmarkImportPlan {
  const existingGroupsByPath = new Map<string, string>();
  const catalogGroupById = new Map(catalog.groups.map((group) => [group.id, group]));
  for (const group of catalog.groups) {
    const parent = group.parentId ? catalogGroupById.get(group.parentId) : undefined;
    existingGroupsByPath.set(`${parent?.name ?? ""}\u0000${group.name}`.toLocaleLowerCase(), group.id);
  }
  const sourceGroupByKey = new Map(parsed.groups.map((group) => [group.key, group]));
  const sourcePath = (group: BookmarkTransferGroup): string => {
    const parent = group.parentKey ? sourceGroupByKey.get(group.parentKey) : undefined;
    return `${parent?.name ?? ""}\u0000${group.name}`.toLocaleLowerCase();
  };
  const createGroups = parsed.groups.filter((group) => !existingGroupsByPath.has(sourcePath(group)));

  const byAddress = new Map<string, { groupId: string; item: CatalogItem }>();
  for (const group of catalog.groups) for (const item of group.items) {
    for (const address of normalizedAddresses(item)) byAddress.set(address, { groupId: group.id, item });
  }
  const reserved = new Set(byAddress.keys());
  const createItems: BookmarkTransferItem[] = [];
  const duplicates: BookmarkImportPlan["duplicates"] = [];
  const conflicts: ImportConflict[] = [];
  for (const imported of parsed.items) {
    const addresses = normalizedAddresses(imported);
    const existing = addresses.map((address) => byAddress.get(address)).find(Boolean);
    const repeated = addresses.some((address) => reserved.has(address));
    const normalized = addresses[0]!;
    if (repeated) {
      duplicates.push({ normalizedUrl: normalized, imported });
      if (existing) {
        const importedGroup = sourceGroupByKey.get(imported.groupKey);
        const existingGroup = catalogGroupById.get(existing.groupId);
        const fields: ImportConflict["fields"] = [];
        if (imported.title !== existing.item.title) fields.push("title");
        if (importedGroup && existingGroup && sourcePath(importedGroup) !== `${existingGroup.parentId ? catalogGroupById.get(existingGroup.parentId)?.name ?? "" : ""}\u0000${existingGroup.name}`.toLocaleLowerCase()) fields.push("group");
        if (imported.localUrl !== undefined && imported.localUrl !== (existing.item.localUrl ?? "")) fields.push("localUrl");
        if (imported.description !== undefined && imported.description !== (existing.item.description ?? "")) fields.push("description");
        if (imported.icon !== undefined && imported.icon !== (existing.item.icon ?? "")) fields.push("icon");
        if (imported.tags !== undefined && !equalTags(imported.tags, existing.item.tags)) fields.push("tags");
        if (fields.length) conflicts.push({ normalizedUrl: normalized, imported, existing, fields });
      }
      continue;
    }
    createItems.push(imported);
    for (const address of addresses) reserved.add(address);
  }
  return {
    format: parsed.format,
    counts: {
      sourceGroups: parsed.groups.length,
      sourceItems: parsed.items.length,
      newGroups: createGroups.length,
      newItems: createItems.length,
      duplicates: duplicates.length,
      conflicts: conflicts.length,
    },
    createGroups,
    createItems,
    duplicates,
    conflicts,
  };
}

function allocateStableId(candidate: string | undefined, used: Set<string>): string {
  let id = candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate.toLowerCase()
    : randomUUID();
  while (used.has(id)) id = randomUUID();
  used.add(id);
  return id;
}

/**
 * Apply only the create operations from a previously reviewed plan to a copy.
 * URL uniqueness is checked again so a stale plan still cannot create duplicates.
 */
export function applyBookmarkImportPlan(
  catalog: DashyCatalog,
  parsed: ParsedBookmarkTransfer,
  plan: BookmarkImportPlan,
): DashyCatalog {
  const result = normalizeCatalog(structuredClone(catalog));
  const usedIds = new Set<string>();
  for (const group of result.groups) {
    usedIds.add(group.id);
    for (const item of group.items) usedIds.add(item.id);
  }
  const sourceGroups = new Map(parsed.groups.map((group) => [group.key, group]));
  const plannedKeys = new Set(plan.createGroups.map((group) => group.key));
  const groupIds = new Map<string, string>();

  const resolveGroup = (key: string, visiting = new Set<string>()): string => {
    const resolved = groupIds.get(key);
    if (resolved) return resolved;
    const source = sourceGroups.get(key);
    if (!source) throw new Error(`Import item references unknown group '${key}'`);
    if (visiting.has(key)) throw new Error("Import groups contain a parent cycle");
    visiting.add(key);
    const parentId = source.parentKey ? resolveGroup(source.parentKey, visiting) : undefined;
    const existing = result.groups.find((group) =>
      group.name.toLocaleLowerCase() === source.name.toLocaleLowerCase() &&
      group.parentId === parentId,
    );
    if (existing) {
      groupIds.set(key, existing.id);
      return existing.id;
    }
    if (!plannedKeys.has(key)) throw new Error(`Import plan does not create missing group '${source.name}'`);
    const id = allocateStableId(source.stableId, usedIds);
    result.groups.push({
      id,
      name: source.name,
      ...(parentId ? { parentId } : {}),
      ...(source.icon ? { icon: source.icon } : {}),
      itemCount: 0,
      items: [],
    });
    groupIds.set(key, id);
    return id;
  };
  for (const group of plan.createGroups) resolveGroup(group.key);

  const reserved = new Set<string>();
  for (const group of result.groups) for (const item of group.items) {
    for (const address of normalizedAddresses(item)) reserved.add(address);
  }
  for (const imported of plan.createItems) {
    const addresses = normalizedAddresses(imported);
    if (addresses.some((address) => reserved.has(address))) continue;
    const targetId = resolveGroup(imported.groupKey);
    const target = result.groups.find((group) => group.id === targetId)!;
    target.items.push({
      id: allocateStableId(imported.stableId, usedIds),
      title: imported.title,
      url: imported.url,
      ...(imported.localUrl ? { localUrl: imported.localUrl } : {}),
      ...(imported.description ? { description: imported.description } : {}),
      ...(imported.icon ? { icon: imported.icon } : {}),
      ...(imported.tags ? { tags: [...imported.tags] } : {}),
    });
    target.itemCount = target.items.length;
    for (const address of addresses) reserved.add(address);
  }
  return normalizeCatalog(result);
}

/** Plan a full native restore. Non-empty targets require an explicit caller confirmation. */
export function planJsonRestore(
  current: DashyCatalog,
  parsed: ParsedBookmarkTransfer,
  options: { confirmReplaceNonEmpty?: boolean } = {},
): JsonRestorePlan {
  if (parsed.format !== "json" || !parsed.backup) throw new Error("A verified JSON backup is required");
  const replacingNonEmptyCatalog = itemCount(current) > 0;
  if (replacingNonEmptyCatalog && !options.confirmReplaceNonEmpty) {
    throw new Error("Restoring over a non-empty catalog requires explicit confirmation");
  }
  const catalog = structuredClone(parsed.backup.catalog);
  if (itemCount(catalog) !== parsed.backup.counts.items || catalog.groups.length !== parsed.backup.counts.groups || computeCatalogVersion(catalog) !== parsed.backup.hash) {
    throw new Error("Catalog backup verification failed before restore");
  }
  return {
    catalog,
    expectedCounts: { ...parsed.backup.counts },
    expectedHash: parsed.backup.hash,
    replacingNonEmptyCatalog,
  };
}
