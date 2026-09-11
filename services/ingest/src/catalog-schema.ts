import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import type {
  CatalogGroup,
  CatalogItem,
  CatalogSettings,
  DashyCatalog,
} from "./types.js";

export const CATALOG_SCHEMA_VERSION = 1 as const;
export const DEFAULT_SETTINGS: Readonly<CatalogSettings> = Object.freeze({
  title: "栖页",
  subtitle: "常去的网站和家里的服务",
  defaultSearchEngine: "duckduckgo",
  localAccessHosts: ["127.0.0.1", "localhost", ".local"],
});

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new CatalogValidationError(`${path} must be a non-empty string up to ${maximum} characters`);
  }
  return value.trim();
}

function optionalString(value: unknown, path: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, path, maximum);
}

function stringArray(
  value: unknown,
  path: string,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new CatalogValidationError(`${path} must be an array with at most ${maximumItems} entries`);
  }
  const values = value.map((entry, index) =>
    requiredString(entry, `${path}[${index}]`, maximumLength),
  );
  if (new Set(values).size !== values.length) {
    throw new CatalogValidationError(`${path} must not contain duplicates`);
  }
  return values;
}

function stableId(value: unknown, path: string, assignIds: boolean): string {
  if (assignIds) {
    if (
      typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ) {
      return randomUUID();
    }
    return value.toLowerCase();
  }
  const id = requiredString(value, path, 100);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new CatalogValidationError(`${path} must be a UUID`);
  }
  return id.toLowerCase();
}

export class CatalogValidationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(500, `Catalog validation failed: ${message}`, "catalog_invalid", details);
    this.name = "CatalogValidationError";
  }
}

export class CatalogCorruptError extends HttpError {
  constructor(path: string, cause?: unknown) {
    super(503, `Catalog file is corrupted and was not modified: ${path}`, "catalog_corrupt", {
      cause: cause instanceof Error ? cause.message : String(cause ?? "invalid JSON"),
    });
    this.name = "CatalogCorruptError";
  }
}

export function computeCatalogVersion(
  catalog: Pick<DashyCatalog, "schemaVersion" | "settings" | "groups">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: catalog.schemaVersion,
        settings: catalog.settings,
        groups: catalog.groups,
      }),
    )
    .digest("hex");
}

export function normalizeCatalog(value: unknown, assignIds = false): DashyCatalog {
  if (!isObject(value)) throw new CatalogValidationError("root must be an object");
  const schemaVersion = value.schemaVersion ?? CATALOG_SCHEMA_VERSION;
  if (schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new CatalogValidationError(`unsupported schemaVersion '${String(schemaVersion)}'`);
  }
  const rawSettings = value.settings === undefined ? {} : value.settings;
  if (!isObject(rawSettings)) throw new CatalogValidationError("settings must be an object");
  const engine = rawSettings.defaultSearchEngine ?? DEFAULT_SETTINGS.defaultSearchEngine;
  if (!['google', 'duckduckgo', 'bing'].includes(String(engine))) {
    throw new CatalogValidationError("settings.defaultSearchEngine must be google, duckduckgo, or bing");
  }
  const localAccessHosts = rawSettings.localAccessHosts === undefined
    ? [...DEFAULT_SETTINGS.localAccessHosts]
    : stringArray(rawSettings.localAccessHosts, "settings.localAccessHosts", 100, 253);
  const settings: CatalogSettings = {
    title: requiredString(rawSettings.title ?? DEFAULT_SETTINGS.title, "settings.title", 100),
    subtitle: requiredString(
      rawSettings.subtitle ?? DEFAULT_SETTINGS.subtitle,
      "settings.subtitle",
      300,
    ),
    defaultSearchEngine: String(engine),
    localAccessHosts,
  };
  if (!Array.isArray(value.groups) || value.groups.length > 500) {
    throw new CatalogValidationError("groups must be an array with at most 500 entries");
  }

  const seenIds = new Set<string>();
  const groups: CatalogGroup[] = value.groups.map((rawGroup, groupIndex) => {
    if (!isObject(rawGroup)) throw new CatalogValidationError(`groups[${groupIndex}] must be an object`);
    const groupId = stableId(rawGroup.id, `groups[${groupIndex}].id`, assignIds);
    if (seenIds.has(groupId)) throw new CatalogValidationError(`duplicate id '${groupId}'`);
    seenIds.add(groupId);
    if (!Array.isArray(rawGroup.items) || rawGroup.items.length > 5_000) {
      throw new CatalogValidationError(`groups[${groupIndex}].items must be an array`);
    }
    const items: CatalogItem[] = rawGroup.items.map((rawItem, itemIndex) => {
      if (!isObject(rawItem)) {
        throw new CatalogValidationError(`groups[${groupIndex}].items[${itemIndex}] must be an object`);
      }
      const itemId = stableId(
        rawItem.id,
        `groups[${groupIndex}].items[${itemIndex}].id`,
        assignIds,
      );
      if (seenIds.has(itemId)) throw new CatalogValidationError(`duplicate id '${itemId}'`);
      seenIds.add(itemId);
      const tags = rawItem.tags === undefined
        ? undefined
        : stringArray(rawItem.tags, `groups[${groupIndex}].items[${itemIndex}].tags`, 20, 50);
      return {
        id: itemId,
        title: requiredString(rawItem.title, `groups[${groupIndex}].items[${itemIndex}].title`, 300),
        url: requiredString(rawItem.url, `groups[${groupIndex}].items[${itemIndex}].url`, 4_096),
        ...(optionalString(rawItem.localUrl, "localUrl", 4_096)
          ? { localUrl: optionalString(rawItem.localUrl, "localUrl", 4_096) }
          : {}),
        ...(optionalString(rawItem.description, "description", 1_000)
          ? { description: optionalString(rawItem.description, "description", 1_000) }
          : {}),
        ...(optionalString(rawItem.icon, "icon", 4_096)
          ? { icon: optionalString(rawItem.icon, "icon", 4_096) }
          : {}),
        ...(tags ? { tags } : {}),
      } as CatalogItem;
    });
    return {
      id: groupId,
      name: requiredString(rawGroup.name, `groups[${groupIndex}].name`, 100),
      ...(optionalString(rawGroup.parentId, `groups[${groupIndex}].parentId`, 100)
        ? { parentId: optionalString(rawGroup.parentId, `groups[${groupIndex}].parentId`, 100) }
        : {}),
      ...(optionalString(rawGroup.icon, `groups[${groupIndex}].icon`, 500)
        ? { icon: optionalString(rawGroup.icon, `groups[${groupIndex}].icon`, 500) }
        : {}),
      itemCount: items.length,
      items,
    } as CatalogGroup;
  });
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const siblingNames = new Set<string>();
  for (const group of groups) {
    if (group.parentId) {
      const parent = groupById.get(group.parentId);
      if (!parent) throw new CatalogValidationError(`group '${group.id}' references an unknown parentId`);
      if (parent.id === group.id || parent.parentId) {
        throw new CatalogValidationError(`group '${group.id}' exceeds the supported two-level hierarchy`);
      }
    }
    const siblingKey = `${group.parentId ?? "root"}\u0000${group.name.toLocaleLowerCase()}`;
    if (siblingNames.has(siblingKey)) throw new CatalogValidationError(`duplicate sibling group name '${group.name}'`);
    siblingNames.add(siblingKey);
  }
  const catalog = { schemaVersion: CATALOG_SCHEMA_VERSION, version: "", settings, groups };
  catalog.version = computeCatalogVersion(catalog);
  return catalog;
}

export function createEmptyCatalog(defaultGroup = "收件箱"): DashyCatalog {
  return normalizeCatalog(
    {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      settings: DEFAULT_SETTINGS,
      groups: [{ id: randomUUID(), name: defaultGroup, items: [] }],
    },
    false,
  );
}
