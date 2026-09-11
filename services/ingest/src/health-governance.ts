import { HttpError } from "./errors.js";
import { normalizeUrl } from "./url.js";
import type { CatalogGroup, CatalogItem, DashyCatalog } from "./types.js";

export type HealthAction =
  | { id: string; type: "fill_metadata"; itemId: string; expectedUrl: string; metadata: Partial<Pick<CatalogItem, "title" | "description" | "icon">> }
  | { id: string; type: "delete_item"; itemId: string; expectedGroupId: string; expectedUrl: string }
  | { id: string; type: "replace_url"; itemId: string; expectedUrl: string; url: string }
  | { id: string; type: "move_item"; itemId: string; expectedGroupId: string; targetGroupId: string }
  | { id: string; type: "delete_empty_group"; groupId: string; expectedName: string };

export interface HealthActionConflict {
  actionId: string;
  type: HealthAction["type"];
  reason: "item_missing" | "group_missing" | "field_changed" | "group_not_empty" | "duplicate_target";
  current?: unknown;
}

export interface HealthOperation {
  actionId: string;
  type: HealthAction["type"];
  itemId?: string;
  groupId?: string;
  before?: unknown;
  after?: unknown;
}

export interface HealthChangeSetResult {
  changeSetId?: string;
  status: "conflicts" | "partially_applied" | "applied";
  beforeVersion: string;
  afterVersion: string;
  operations: HealthOperation[];
  conflicts: HealthActionConflict[];
  backupId?: string;
  appliedAt?: string;
}

export function applyHealthActionsToCatalog(
  catalog: DashyCatalog,
  actions: readonly HealthAction[],
): { operations: HealthOperation[]; conflicts: HealthActionConflict[] } {
  if (actions.length > 5_000 || new Set(actions.map(({ id }) => id)).size !== actions.length) {
    throw new HttpError(400, "Health actions must have unique ids", "invalid_request");
  }
  const operations: HealthOperation[] = [];
  const conflicts: HealthActionConflict[] = [];
  for (const action of actions) {
    if (action.type === "delete_empty_group") {
      const group = catalog.groups.find(({ id }) => id === action.groupId);
      if (!group) {
        conflicts.push({ actionId: action.id, type: action.type, reason: "group_missing" });
      } else if (group.name !== action.expectedName) {
        conflicts.push({ actionId: action.id, type: action.type, reason: "field_changed", current: group.name });
      } else if (group.items.length || catalog.groups.some(({ parentId }) => parentId === group.id)) {
        conflicts.push({ actionId: action.id, type: action.type, reason: "group_not_empty" });
      } else {
        catalog.groups.splice(catalog.groups.indexOf(group), 1);
        operations.push({ actionId: action.id, type: action.type, groupId: group.id, before: { name: group.name } });
      }
      continue;
    }
    const located = locateItem(catalog, action.itemId);
    if (!located) {
      conflicts.push({ actionId: action.id, type: action.type, reason: "item_missing" });
      continue;
    }
    if (action.type === "delete_item") {
      if (located.group.id !== action.expectedGroupId || located.item.url !== action.expectedUrl) {
        conflicts.push({ actionId: action.id, type: action.type, reason: "field_changed", current: { groupId: located.group.id, url: located.item.url } });
        continue;
      }
      located.group.items.splice(located.group.items.indexOf(located.item), 1);
      located.group.itemCount = located.group.items.length;
      operations.push({ actionId: action.id, type: action.type, itemId: located.item.id, groupId: located.group.id, before: structuredClone(located.item) });
    } else if (action.type === "fill_metadata") {
      if (located.item.url !== action.expectedUrl) {
        conflicts.push({ actionId: action.id, type: action.type, reason: "field_changed" });
        continue;
      }
      const before = structuredClone(located.item);
      for (const field of ["title", "description", "icon"] as const) {
        if (!located.item[field]?.trim() && action.metadata[field]?.trim()) located.item[field] = action.metadata[field]!.trim();
      }
      if (JSON.stringify(before) !== JSON.stringify(located.item)) operations.push({ actionId: action.id, type: action.type, itemId: action.itemId, before, after: structuredClone(located.item) });
    } else if (action.type === "replace_url") {
      if (located.item.url !== action.expectedUrl) {
        conflicts.push({ actionId: action.id, type: action.type, reason: "field_changed", current: located.item.url });
        continue;
      }
      const normalized = normalizeUrl(action.url);
      const duplicate = catalog.groups.some((group) => group.items.some((item) =>
        item.id !== located.item.id && [item.url, item.localUrl].filter(Boolean).some((url) => {
          try { return normalizeUrl(url as string) === normalized; } catch { return false; }
        })));
      if (duplicate) {
        conflicts.push({ actionId: action.id, type: action.type, reason: "duplicate_target", current: normalized });
        continue;
      }
      const before = located.item.url;
      located.item.url = normalized;
      operations.push({ actionId: action.id, type: action.type, itemId: located.item.id, before, after: normalized });
    } else {
      const target = catalog.groups.find(({ id }) => id === action.targetGroupId);
      if (!target) {
        conflicts.push({ actionId: action.id, type: action.type, reason: "group_missing" });
      } else if (located.group.id !== action.expectedGroupId) {
        conflicts.push({ actionId: action.id, type: action.type, reason: "field_changed", current: located.group.id });
      } else if (target.id !== located.group.id) {
        located.group.items.splice(located.group.items.indexOf(located.item), 1);
        target.items.push(located.item);
        located.group.itemCount = located.group.items.length;
        target.itemCount = target.items.length;
        operations.push({ actionId: action.id, type: action.type, itemId: located.item.id, before: located.group.id, after: target.id });
      }
    }
  }
  return { operations, conflicts };
}

function locateItem(catalog: DashyCatalog, itemId: string): { group: CatalogGroup; item: CatalogItem } | undefined {
  for (const group of catalog.groups) {
    const item = group.items.find(({ id }) => id === itemId);
    if (item) return { group, item };
  }
  return undefined;
}
