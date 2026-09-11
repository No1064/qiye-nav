import { createHash } from "node:crypto";
import { HttpError } from "./errors.js";
import { ImportSessions } from "./import-sessions.js";
import { fallbackTitle, normalizeBookmarkUrl, normalizeUrl } from "./url.js";
import type { CatalogRepository } from "./types.js";

export interface BatchBookmark {
  clientId?: string;
  url?: string;
  title?: string;
  folderPath?: string[];
  error?: { code: string; message: string };
}

export interface BookmarkBatchInput {
  source: "chrome_extension";
  importSessionId: string;
  defaultGroupId?: string;
  items: BatchBookmark[];
}

export interface BookmarkBatchResult {
  summary: { total: number; created: number; duplicate: number; invalid: number; failed: number };
  results: Array<{
    index: number;
    clientId?: string;
    status: "created" | "duplicate" | "invalid" | "failed";
    groupId?: string;
    itemId?: string;
    error?: { code: string; message: string };
  }>;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object", "invalid_request");
  }
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new HttpError(400, `${field} must be 1-${maximum} characters`, "invalid_request");
  }
  return value.trim();
}

export function parseBookmarkBatch(value: unknown): BookmarkBatchInput {
  const input = objectValue(value);
  if (input.source !== "chrome_extension") {
    throw new HttpError(400, "source must be chrome_extension", "invalid_request");
  }
  const importSessionId = optionalText(input.importSessionId, "importSessionId", 200);
  if (!importSessionId) throw new HttpError(400, "importSessionId is required", "invalid_request");
  const defaultGroupId = optionalText(input.defaultGroupId, "defaultGroupId", 200);
  const rawItems = input.items ?? input.bookmarks;
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 200) {
    throw new HttpError(400, "items must contain 1-200 bookmarks", "invalid_request");
  }
  const items = rawItems.map((raw, index): BatchBookmark => {
    try {
      const item = objectValue(raw);
      const clientId = optionalText(item.clientId ?? item.id, `items[${index}].clientId`, 200);
      const url = optionalText(item.url, `items[${index}].url`, 4_096);
      const title = optionalText(item.title, `items[${index}].title`, 300);
      let folderPath: string[] | undefined;
      if (item.folderPath !== undefined) {
        if (!Array.isArray(item.folderPath) || item.folderPath.length > 20) {
          throw new HttpError(400, `items[${index}].folderPath must be an array`, "invalid_request");
        }
        folderPath = item.folderPath.map((part, partIndex) => {
          const parsed = optionalText(part, `items[${index}].folderPath[${partIndex}]`, 100);
          if (!parsed) throw new HttpError(400, "folderPath entries must not be empty", "invalid_request");
          return parsed;
        });
      }
      return {
        ...(clientId ? { clientId } : {}),
        ...(url ? { url } : {}),
        ...(title ? { title } : {}),
        ...(folderPath?.length ? { folderPath } : {}),
      };
    } catch (error) {
      const known = error instanceof HttpError;
      return {
        error: {
          code: known ? error.code : "invalid_request",
          message: known ? error.message : "Bookmark is invalid",
        },
      };
    }
  });
  const folderKeys = new Set<string>();
  for (const item of items) {
    for (const group of hierarchyGroups(item.folderPath ?? [])) folderKeys.add(group.key);
  }
  if (folderKeys.size > 100) {
    throw new HttpError(400, "A batch may reference at most 100 folder groups", "too_many_groups");
  }
  return {
    source: "chrome_extension",
    importSessionId,
    ...(defaultGroupId ? { defaultGroupId } : {}),
    items,
  };
}

function groupName(path: readonly string[]): string {
  const joined = path.join(" / ");
  if (joined.length <= 100) return joined;
  const suffix = createHash("sha256").update(JSON.stringify(path)).digest("hex").slice(0, 10);
  return `${joined.slice(0, 86).trimEnd()} … ${suffix}`;
}

function hierarchyGroups(path: readonly string[]): Array<{ key: string; name: string; parentKey?: string }> {
  if (!path.length) return [];
  const rootKey = JSON.stringify([path[0]]);
  const groups: Array<{ key: string; name: string; parentKey?: string }> = [{ key: rootKey, name: groupName([path[0] as string]) }];
  if (path.length > 1) groups.push({ key: JSON.stringify(path), name: groupName(path.slice(1)), parentKey: rootKey });
  return groups;
}

export async function importBookmarkBatch(
  store: CatalogRepository,
  input: BookmarkBatchInput,
  sessions: ImportSessions,
): Promise<BookmarkBatchResult> {
  const pathKeys = new Set<string>();
  for (const item of input.items) {
    for (const group of hierarchyGroups(item.folderPath ?? [])) pathKeys.add(group.key);
  }
  await sessions.reserve(input.importSessionId, [...pathKeys]);
  if (input.defaultGroupId) {
    const catalog = await store.getCatalog();
    if (!catalog.groups.some((group) => group.id === input.defaultGroupId)) {
      throw new HttpError(404, `Group '${input.defaultGroupId}' does not exist`, "group_not_found");
    }
  }
  const summary = { total: input.items.length, created: 0, duplicate: 0, invalid: 0, failed: 0 };
  const results: BookmarkBatchResult["results"] = [];
  const folderGroups = new Map<string, string>();

  for (const [index, inputItem] of input.items.entries()) {
    const resultBase = { index, ...(inputItem.clientId ? { clientId: inputItem.clientId } : {}) };
    if (inputItem.error || !inputItem.url) {
      summary.invalid += 1;
      results.push({
        ...resultBase,
        status: "invalid",
        error: inputItem.error ?? { code: "missing_url", message: "url is required" },
      });
      continue;
    }
    try {
      const url = normalizeBookmarkUrl(inputItem.url, "url");
      const duplicateKey = normalizeUrl(url);
      let targetGroupId = input.defaultGroupId;
      if (inputItem.folderPath?.length) {
        for (const groupSpec of hierarchyGroups(inputItem.folderPath)) {
          const parentId = groupSpec.parentKey ? folderGroups.get(groupSpec.parentKey) : undefined;
          const cacheKey = groupSpec.key;
          let groupId = folderGroups.get(cacheKey);
          if (!groupId) {
            let catalog = await store.getCatalog();
            let group = catalog.groups.find((candidate) => candidate.parentId === parentId && candidate.name.toLowerCase() === groupSpec.name.toLowerCase());
            if (!group) {
              await store.createGroup({ name: groupSpec.name, ...(parentId ? { parentId } : {}) });
              catalog = await store.getCatalog();
              group = catalog.groups.find((candidate) => candidate.parentId === parentId && candidate.name.toLowerCase() === groupSpec.name.toLowerCase());
            }
            if (!group) throw new Error("created folder group was not found");
            groupId = group.id;
            folderGroups.set(cacheKey, groupId);
          }
          targetGroupId = groupId;
        }
      }
      const duplicate = await store.findDuplicate(new Set([duplicateKey]));
      if (duplicate) {
        summary.duplicate += 1;
        results.push({
          ...resultBase,
          status: "duplicate",
          groupId: duplicate.groupId,
          itemId: duplicate.itemId,
        });
        continue;
      }
      const created = await store.addBookmark(targetGroupId, {
        title: inputItem.title ?? fallbackTitle(url),
        url,
      });
      const itemId = (created.result as { id?: unknown } | undefined)?.id;
      summary.created += 1;
      results.push({
        ...resultBase,
        status: "created",
        groupId: created.group.id,
        ...(typeof itemId === "string" ? { itemId } : {}),
      });
    } catch (error) {
      const known = error instanceof HttpError;
      if (known && ["invalid_url", "invalid_url_scheme", "url_credentials_forbidden"].includes(error.code)) {
        summary.invalid += 1;
        results.push({
          ...resultBase,
          status: "invalid",
          error: { code: error.code, message: error.message },
        });
      } else {
        summary.failed += 1;
        results.push({
          ...resultBase,
          status: "failed",
          error: {
            code: known ? error.code : "bookmark_import_failed",
            message: known ? error.message : "Bookmark could not be imported",
          },
        });
      }
    }
  }
  return { summary, results };
}
