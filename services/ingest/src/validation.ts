import { HttpError } from "./errors.js";
import type {
  BookmarkInput,
  CatalogSettingsPatch,
  GroupInput,
  GroupPatch,
} from "./types.js";

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a string`, "invalid_request");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new HttpError(400, `${field} must be 1-${maxLength} characters`, "invalid_request");
  }
  return normalized;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object", "invalid_request");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  const parsed = optionalString(value, field, maxLength);
  if (!parsed) throw new HttpError(400, `${field} is required`, "invalid_request");
  return parsed;
}

function clearableString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return optionalString(value, field, maxLength);
}

function tagsValue(value: unknown, clearable = false): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (clearable && value === null) return null;
  if (!Array.isArray(value) || value.length > 20) {
    throw new HttpError(400, "tags must be an array with at most 20 entries", "invalid_request");
  }
  const tags = value.map((tag) => requiredString(tag, "tag", 50));
  if (new Set(tags).size !== tags.length) {
    throw new HttpError(400, "tags must not contain duplicates", "invalid_request");
  }
  return tags;
}

function stringIdArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new HttpError(400, `${field} must be an array`, "invalid_request");
  }
  return value.map((id) => requiredString(id, field, 100));
}

export function parseBookmarkInput(value: unknown): BookmarkInput {
  const input = objectValue(value);
  const url = optionalString(input.url, "url", 4_096);
  const remoteUrl = optionalString(input.remoteUrl, "remoteUrl", 4_096);
  const localUrl = optionalString(input.localUrl, "localUrl", 4_096);
  const title = optionalString(input.title, "title", 300);
  const description = optionalString(input.description, "description", 1_000);
  const icon = optionalString(input.icon, "icon", 4_096);
  const groupId = optionalString(input.groupId, "groupId", 200);
  const source = optionalString(input.source, "source", 64);
  const trigger = optionalString(input.trigger, "trigger", 64);
  const parsed: BookmarkInput = {
    ...(url ? { url } : {}),
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(localUrl ? { localUrl } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(groupId ? { groupId } : {}),
    ...(source ? { source } : {}),
    ...(trigger ? { trigger } : {}),
  };
  if (!parsed.url && !parsed.remoteUrl && !parsed.localUrl) {
    throw new HttpError(
      400,
      "At least one of url, remoteUrl, or localUrl is required",
      "missing_url",
    );
  }
  return parsed;
}

export function parseGroupCreate(value: unknown): GroupInput {
  const input = objectValue(value);
  const icon = optionalString(input.icon, "icon", 500);
  const parentId = optionalString(input.parentId, "parentId", 100);
  return {
    name: requiredString(input.name, "name", 100),
    ...(icon ? { icon } : {}),
    ...(parentId ? { parentId } : {}),
  };
}

export function parseGroupPatch(value: unknown): GroupPatch {
  const input = objectValue(value);
  const name = input.name === undefined ? undefined : requiredString(input.name, "name", 100);
  const icon = clearableString(input.icon, "icon", 500);
  const parentId = clearableString(input.parentId, "parentId", 100);
  if (name === undefined && icon === undefined && parentId === undefined) {
    throw new HttpError(400, "At least one group field is required", "invalid_request");
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
  };
}

export interface AdminItemInput extends BookmarkInput {
  groupId: string;
  tags?: string[];
}

export function parseAdminItemCreate(value: unknown): AdminItemInput {
  const input = objectValue(value);
  const bookmark = parseBookmarkInput(input);
  const groupId = requiredString(input.groupId, "groupId", 200);
  const tags = tagsValue(input.tags);
  return {
    ...bookmark,
    groupId,
    ...(tags ? { tags } : {}),
  };
}

export interface AdminItemPatchInput {
  title?: string;
  url?: string;
  remoteUrl?: string;
  localUrl?: string | null;
  description?: string | null;
  icon?: string | null;
  tags?: string[] | null;
}

export function parseAdminItemPatch(value: unknown): AdminItemPatchInput {
  const input = objectValue(value);
  const title = input.title === undefined ? undefined : requiredString(input.title, "title", 300);
  const url = optionalString(input.url, "url", 4_096);
  const remoteUrl = optionalString(input.remoteUrl, "remoteUrl", 4_096);
  const localUrl = clearableString(input.localUrl, "localUrl", 4_096);
  const description = clearableString(input.description, "description", 1_000);
  const icon = clearableString(input.icon, "icon", 4_096);
  const tags = tagsValue(input.tags, true);
  const parsed: AdminItemPatchInput = {
    ...(title !== undefined ? { title } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(remoteUrl !== undefined ? { remoteUrl } : {}),
    ...(localUrl !== undefined ? { localUrl } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };
  if (Object.keys(parsed).length === 0) {
    throw new HttpError(400, "At least one item field is required", "invalid_request");
  }
  return parsed;
}

export function parseMetadataPreview(value: unknown): { url: string } {
  const input = objectValue(value);
  return { url: requiredString(input.url, "url", 4_096) };
}

export function parseGroupDelete(value: unknown): {
  moveItemsToGroupId?: string;
  deleteItems?: boolean;
} {
  if (value === undefined) return {};
  const input = objectValue(value);
  const rawTarget = input.moveItemsToGroupId ?? input.moveToGroupId;
  const moveItemsToGroupId = optionalString(rawTarget, "moveItemsToGroupId", 100);
  if (input.deleteItems !== undefined && typeof input.deleteItems !== "boolean") {
    throw new HttpError(400, "deleteItems must be a boolean", "invalid_request");
  }
  return {
    ...(moveItemsToGroupId ? { moveItemsToGroupId } : {}),
    ...(typeof input.deleteItems === "boolean" ? { deleteItems: input.deleteItems } : {}),
  };
}

export function parseMoveItem(value: unknown): { targetGroupId: string; targetIndex?: number } {
  const input = objectValue(value);
  const targetGroupId = requiredString(
    input.targetGroupId ?? input.toGroupId,
    "targetGroupId",
    100,
  );
  if (
    input.targetIndex !== undefined &&
    (!Number.isInteger(input.targetIndex) || (input.targetIndex as number) < 0)
  ) {
    throw new HttpError(400, "targetIndex must be a non-negative integer", "invalid_request");
  }
  return {
    targetGroupId,
    ...(typeof input.targetIndex === "number" ? { targetIndex: input.targetIndex } : {}),
  };
}

export interface BulkMoveItemsInput {
  items: Array<{ groupId: string; itemId: string }>;
  targetGroupId: string;
  targetIndex?: number;
}

export function parseBulkMoveItems(value: unknown): BulkMoveItemsInput {
  const input = objectValue(value);
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 5_000) {
    throw new HttpError(400, "items must contain 1-5000 item references", "invalid_request");
  }
  const items = input.items.map((raw, index) => {
    const entry = objectValue(raw);
    return {
      groupId: requiredString(entry.groupId, `items[${index}].groupId`, 100),
      itemId: requiredString(entry.itemId, `items[${index}].itemId`, 100),
    };
  });
  const keys = items.map(({ groupId, itemId }) => `${groupId}\0${itemId}`);
  if (new Set(keys).size !== keys.length) {
    throw new HttpError(400, "items must not contain duplicates", "duplicate_move_item");
  }
  const targetGroupId = requiredString(input.targetGroupId, "targetGroupId", 100);
  if (input.targetIndex !== undefined &&
      (!Number.isInteger(input.targetIndex) || (input.targetIndex as number) < 0)) {
    throw new HttpError(400, "targetIndex must be a non-negative integer", "invalid_request");
  }
  return { items, targetGroupId,
    ...(typeof input.targetIndex === "number" ? { targetIndex: input.targetIndex } : {}),
  };
}

export type OrderInput =
  | { scope: "groups"; groupIds: string[] }
  | { scope: "items"; groupId: string; itemIds: string[] };

export function parseOrder(value: unknown): OrderInput {
  const input = objectValue(value);
  const scope = input.scope ?? input.type;
  if (scope === "groups") {
    return { scope, groupIds: stringIdArray(input.groupIds, "groupIds") };
  }
  if (scope === "items") {
    return {
      scope,
      groupId: requiredString(input.groupId, "groupId", 100),
      itemIds: stringIdArray(input.itemIds, "itemIds"),
    };
  }
  throw new HttpError(400, "scope must be 'groups' or 'items'", "invalid_request");
}

export function parseSettingsPatch(value: unknown): CatalogSettingsPatch {
  const input = objectValue(value);
  const title = input.title === undefined ? undefined : requiredString(input.title, "title", 100);
  const subtitle = input.subtitle === undefined
    ? undefined
    : requiredString(input.subtitle, "subtitle", 300);
  let defaultSearchEngine: string | undefined;
  if (input.defaultSearchEngine !== undefined) {
    defaultSearchEngine = requiredString(
      input.defaultSearchEngine,
      "defaultSearchEngine",
      20,
    );
    if (!["google", "duckduckgo", "bing"].includes(defaultSearchEngine)) {
      throw new HttpError(
        400,
        "defaultSearchEngine must be google, duckduckgo, or bing",
        "invalid_request",
      );
    }
  }
  let localAccessHosts: string[] | undefined;
  if (input.localAccessHosts !== undefined) {
    if (!Array.isArray(input.localAccessHosts) || input.localAccessHosts.length > 100) {
      throw new HttpError(
        400,
        "localAccessHosts must be an array with at most 100 entries",
        "invalid_request",
      );
    }
    localAccessHosts = input.localAccessHosts.map((host, index) => {
      const value = requiredString(host, `localAccessHosts[${index}]`, 253).toLowerCase();
      if (
        value.includes("://") ||
        value.includes("/") ||
        value.includes("?") ||
        value.includes("#") ||
        /\s/.test(value) ||
        !/^\.?[a-z0-9:[\]._-]+$/i.test(value)
      ) {
        throw new HttpError(
          400,
          `localAccessHosts[${index}] must be a hostname, IP, or .suffix rule`,
          "invalid_request",
        );
      }
      return value;
    });
    localAccessHosts = [...new Set(localAccessHosts)];
  }
  const patch: CatalogSettingsPatch = {
    ...(title !== undefined ? { title } : {}),
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(defaultSearchEngine !== undefined ? { defaultSearchEngine } : {}),
    ...(localAccessHosts !== undefined ? { localAccessHosts } : {}),
  };
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, "At least one settings field is required", "invalid_request");
  }
  return patch;
}
