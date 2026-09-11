import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  CatalogCorruptError,
  computeCatalogVersion,
  createEmptyCatalog,
  normalizeCatalog,
} from "./catalog-schema.js";
import { HttpError } from "./errors.js";
import { normalizeUrl } from "./url.js";
import { applyHealthActionsToCatalog, type HealthAction, type HealthChangeSetResult } from "./health-governance.js";
import type {
  CatalogGroup,
  CatalogItem,
  CatalogRepository,
  CatalogSettingsPatch,
  AiGroupPlan,
  AiApplyConflict,
  AiApplyResult,
  AiChangeOperation,
  AiRestoreResult,
  AiSuggestion,
  DashyCatalog,
  DashyGroup,
  DashyItem,
  DuplicateItem,
  GroupInput,
  GroupPatch,
  ItemPatch,
} from "./types.js";

export interface CatalogStoreOptions {
  catalogPath: string;
  backupDir: string;
  initPath?: string;
  defaultGroup?: string;
}

export interface CatalogReplacementResult {
  changeSetId: string;
  kind: "bookmark_import" | "json_restore";
  beforeVersion: string;
  afterVersion: string;
  backupId: string;
  appliedAt: string;
}

type CatalogMutation = (catalog: DashyCatalog) => void;

interface CatalogMutationReceipt {
  before: DashyCatalog;
  after: DashyCatalog;
  backupId: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function publicGroup(group: CatalogGroup): DashyGroup {
  const { items: _items, ...value } = group;
  return value;
}

function findGroup(catalog: DashyCatalog, idOrName: string): CatalogGroup | undefined {
  const direct = catalog.groups.find((group) => group.id === idOrName || group.name === idOrName);
  if (direct) return direct;
  if (/^(0|[1-9]\d*)$/.test(idOrName)) return catalog.groups[Number(idOrName)];
  return undefined;
}

function requireGroup(catalog: DashyCatalog, idOrName: string): CatalogGroup {
  const group = findGroup(catalog, idOrName);
  if (!group) throw new HttpError(404, `Group '${idOrName}' does not exist`, "group_not_found");
  return group;
}

function assertGroupParent(catalog: DashyCatalog, groupId: string | undefined, parentId: string | undefined): void {
  if (!parentId) return;
  const parent = requireGroup(catalog, parentId);
  if (parent.id === groupId) throw new HttpError(400, "A group cannot be its own parent", "invalid_group_parent");
  if (parent.parentId) throw new HttpError(400, "Groups support at most two levels", "invalid_group_parent");
  if (groupId && catalog.groups.some((group) => group.parentId === groupId)) {
    throw new HttpError(400, "A parent group with children cannot become a child", "invalid_group_parent");
  }
}

function assertUniqueSiblingName(
  catalog: DashyCatalog,
  name: string,
  parentId: string | undefined,
  excludeId?: string,
): void {
  if (catalog.groups.some((group) => group.id !== excludeId && group.parentId === parentId &&
      group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new HttpError(409, "A sibling group with this name already exists", "duplicate_group");
  }
}

function findItem(group: CatalogGroup, id: string): CatalogItem | undefined {
  const direct = group.items.find((item) => item.id === id);
  if (direct) return direct;
  if (/^(0|[1-9]\d*)$/.test(id)) return group.items[Number(id)];
  return undefined;
}

function requireItem(group: CatalogGroup, id: string): CatalogItem {
  const item = findItem(group, id);
  if (!item) throw new HttpError(404, `Item '${id}' does not exist`, "item_not_found");
  return item;
}

function orderedByIds<T extends { id: string }>(values: T[], ids: string[], resource: string): T[] {
  if (ids.length !== values.length || new Set(ids).size !== values.length) {
    throw new HttpError(400, `${resource} order must contain every current id exactly once`, "invalid_order");
  }
  const ordered = ids.map((id) => {
    const direct = values.find((value) => value.id === id);
    const value = direct ?? (/^(0|[1-9]\d*)$/.test(id) ? values[Number(id)] : undefined);
    if (!value) throw new HttpError(400, `${resource} order contains unknown id '${id}'`, "invalid_order");
    return value;
  });
  if (new Set(ordered.map((value) => value.id)).size !== values.length) {
    throw new HttpError(400, `${resource} order must contain every current id exactly once`, "invalid_order");
  }
  return ordered;
}

export class CatalogStore implements CatalogRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly options: CatalogStoreOptions) {}

  static async open(options: CatalogStoreOptions): Promise<CatalogStore> {
    const normalized: CatalogStoreOptions = {
      catalogPath: resolve(options.catalogPath),
      backupDir: resolve(options.backupDir),
      ...(options.initPath ? { initPath: resolve(options.initPath) } : {}),
      ...(options.defaultGroup ? { defaultGroup: options.defaultGroup } : {}),
    };
    const store = new CatalogStore(normalized);
    await mkdir(dirname(normalized.catalogPath), { recursive: true });
    await mkdir(normalized.backupDir, { recursive: true });
    try {
      await stat(normalized.catalogPath);
      await store.getCatalog();
      return store;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    let catalog: DashyCatalog;
    if (normalized.initPath) {
      const { loadCatalogSource } = await import("./migration.js");
      catalog = await loadCatalogSource(normalized.initPath);
    } else {
      catalog = createEmptyCatalog(normalized.defaultGroup);
    }
    await CatalogStore.initializeFile({
      catalogPath: normalized.catalogPath,
      backupDir: normalized.backupDir,
      catalog,
    });
    return store;
  }

  static async initializeFile(options: {
    catalogPath: string;
    backupDir: string;
    catalog: DashyCatalog;
  }): Promise<void> {
    const catalogPath = resolve(options.catalogPath);
    await mkdir(dirname(catalogPath), { recursive: true });
    await mkdir(resolve(options.backupDir), { recursive: true });
    const catalog = normalizeCatalog(options.catalog, true);
    await CatalogStore.atomicReplace(catalogPath, catalog);
  }

  async getCatalog(): Promise<DashyCatalog> {
    let text: string;
    try {
      text = await readFile(this.options.catalogPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HttpError(503, "Catalog file is missing", "catalog_missing");
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(text);
      const catalog = normalizeCatalog(parsed, false);
      if (
        typeof parsed.version !== "string" ||
        parsed.version !== catalog.version ||
        catalog.version !== computeCatalogVersion(catalog)
      ) {
        throw new Error("stored version does not match catalog contents");
      }
      return catalog;
    } catch (error) {
      if (error instanceof CatalogCorruptError) throw error;
      throw new CatalogCorruptError(this.options.catalogPath, error);
    }
  }

  async listGroups(): Promise<DashyGroup[]> {
    return (await this.getCatalog()).groups.map(publicGroup);
  }

  async findDuplicate(normalizedUrls: ReadonlySet<string>): Promise<DuplicateItem | undefined> {
    const catalog = await this.getCatalog();
    for (const group of catalog.groups) {
      for (const item of group.items) {
        const urls = [item.url, item.localUrl].filter((value): value is string => !!value);
        if (
          urls.some((url) => {
            try {
              return normalizedUrls.has(normalizeUrl(url));
            } catch {
              return false;
            }
          })
        ) {
          const { id: itemId, ...bookmark } = item;
          return { groupId: group.id, groupName: group.name, itemId, item: bookmark };
        }
      }
    }
    return undefined;
  }

  async addBookmark(
    groupId: string | undefined,
    item: DashyItem,
  ): Promise<{ group: DashyGroup; result: unknown }> {
    let createdGroup: DashyGroup | undefined;
    let itemId = "";
    await this.mutate((catalog) => {
      const group = groupId
        ? requireGroup(catalog, groupId)
        : findGroup(catalog, this.options.defaultGroup ?? "收件箱") ?? catalog.groups[0];
      if (!group) throw new HttpError(409, "Catalog has no groups", "catalog_has_no_groups");
      itemId = randomUUID();
      group.items.push({ id: itemId, ...clone(item) });
      group.itemCount = group.items.length;
      createdGroup = publicGroup(group);
    });
    return { group: createdGroup as DashyGroup, result: { id: itemId } };
  }

  async createGroup(input: GroupInput): Promise<void> {
    await this.mutate((catalog) => {
      assertGroupParent(catalog, undefined, input.parentId);
      assertUniqueSiblingName(catalog, input.name, input.parentId);
      catalog.groups.push({ id: randomUUID(), ...clone(input), itemCount: 0, items: [] });
    });
  }

  async updateGroup(groupId: string, patch: GroupPatch): Promise<void> {
    await this.mutate((catalog) => {
      const group = requireGroup(catalog, groupId);
      const parentId = patch.parentId === null ? undefined : patch.parentId ?? group.parentId;
      assertGroupParent(catalog, group.id, parentId);
      assertUniqueSiblingName(catalog, patch.name ?? group.name, parentId, group.id);
      if (patch.name !== undefined) group.name = patch.name;
      if (patch.icon === null) delete group.icon;
      else if (patch.icon !== undefined) group.icon = patch.icon;
      if (patch.parentId === null) delete group.parentId;
      else if (patch.parentId !== undefined) group.parentId = patch.parentId;
    });
  }

  async deleteGroup(
    groupId: string,
    options: { moveItemsToGroupId?: string; deleteItems?: boolean },
  ): Promise<void> {
    await this.mutate((catalog) => {
      const group = requireGroup(catalog, groupId);
      if (catalog.groups.some((candidate) => candidate.parentId === group.id)) {
        throw new HttpError(409, "Move or delete child groups before deleting their parent", "group_has_children");
      }
      if (options.moveItemsToGroupId) {
        const destination = requireGroup(catalog, options.moveItemsToGroupId);
        if (destination.id === group.id) {
          throw new HttpError(400, "A group cannot migrate items to itself", "invalid_migration_target");
        }
        destination.items.push(...group.items);
        destination.itemCount = destination.items.length;
      } else if (group.items.length > 0 && options.deleteItems !== true) {
        throw new HttpError(
          409,
          "Group is not empty; choose a migration target or explicitly delete its items",
          "group_not_empty",
        );
      }
      catalog.groups.splice(catalog.groups.indexOf(group), 1);
    });
  }

  async createItem(groupId: string, item: DashyItem): Promise<void> {
    await this.mutate((catalog) => {
      const group = requireGroup(catalog, groupId);
      group.items.push({ id: randomUUID(), ...clone(item) });
      group.itemCount = group.items.length;
    });
  }

  async updateItem(groupId: string, itemId: string, patch: ItemPatch): Promise<void> {
    await this.mutate((catalog) => {
      const item = requireItem(requireGroup(catalog, groupId), itemId);
      for (const field of ["title", "url"] as const) {
        if (patch[field] !== undefined) item[field] = patch[field];
      }
      for (const field of ["localUrl", "description", "icon", "tags"] as const) {
        const value = patch[field];
        if (value === null) delete (item as unknown as Record<string, unknown>)[field];
        else if (value !== undefined) {
          (item as unknown as Record<string, unknown>)[field] = clone(value);
        }
      }
    });
  }

  async deleteItem(groupId: string, itemId: string): Promise<void> {
    await this.mutate((catalog) => {
      const group = requireGroup(catalog, groupId);
      const item = requireItem(group, itemId);
      group.items.splice(group.items.indexOf(item), 1);
      group.itemCount = group.items.length;
    });
  }

  async moveItem(
    groupId: string,
    itemId: string,
    targetGroupId: string,
    targetIndex?: number,
  ): Promise<void> {
    await this.mutate((catalog) => {
      const source = requireGroup(catalog, groupId);
      const destination = requireGroup(catalog, targetGroupId);
      const item = requireItem(source, itemId);
      source.items.splice(source.items.indexOf(item), 1);
      const index = targetIndex ?? destination.items.length;
      if (!Number.isInteger(index) || index < 0 || index > destination.items.length) {
        throw new HttpError(400, "targetIndex is outside the destination group", "invalid_target_index");
      }
      destination.items.splice(index, 0, item);
      source.itemCount = source.items.length;
      destination.itemCount = destination.items.length;
    });
  }

  async moveItems(
    references: readonly { groupId: string; itemId: string }[],
    targetGroupId: string,
    targetIndex?: number,
  ): Promise<void> {
    await this.mutate((catalog) => {
      const destination = requireGroup(catalog, targetGroupId);
      const located = references.map(({ groupId, itemId }) => {
        const group = requireGroup(catalog, groupId);
        return { group, item: requireItem(group, itemId) };
      });
      const keys = located.map(({ group, item }) => `${group.id}\0${item.id}`);
      if (new Set(keys).size !== keys.length) {
        throw new HttpError(400, "Bulk move contains duplicate items", "duplicate_move_item");
      }
      const moving = located.filter(({ group }) => group.id !== destination.id);
      const insertionIndex = targetIndex ?? destination.items.length;
      if (!Number.isInteger(insertionIndex) || insertionIndex < 0 || insertionIndex > destination.items.length) {
        throw new HttpError(400, "targetIndex is outside the destination group", "invalid_target_index");
      }
      const touched = new Set<CatalogGroup>();
      for (const { group, item } of moving) {
        group.items.splice(group.items.indexOf(item), 1);
        touched.add(group);
      }
      destination.items.splice(insertionIndex, 0, ...moving.map(({ item }) => item));
      touched.add(destination);
      for (const group of touched) group.itemCount = group.items.length;
    });
  }

  async orderGroups(groupIds: string[]): Promise<void> {
    await this.mutate((catalog) => {
      catalog.groups = orderedByIds(catalog.groups, groupIds, "groups");
    });
  }

  async orderItems(groupId: string, itemIds: string[]): Promise<void> {
    await this.mutate((catalog) => {
      const group = requireGroup(catalog, groupId);
      group.items = orderedByIds(group.items, itemIds, "items");
    });
  }

  async updateSettings(patch: CatalogSettingsPatch): Promise<void> {
    await this.mutate((catalog) => {
      catalog.settings = { ...catalog.settings, ...clone(patch) };
    });
  }

  async applyAiSuggestions(
    suggestions: readonly AiSuggestion[],
    options: { retireEmptyGroupIds?: readonly string[]; groupPlan?: AiGroupPlan } = {},
  ): Promise<AiApplyResult> {
    const receipt = await this.mutate((catalog) => {
      if (options.groupPlan) {
        const planById = new Map(options.groupPlan.groups.map((group) => [group.id, group]));
        for (const planned of options.groupPlan.groups.filter((group) => group.existingGroupId)) {
          const current = catalog.groups.find((group) => group.id === planned.existingGroupId);
          const parentPlan = planned.parentPlanGroupId ? planById.get(planned.parentPlanGroupId) : undefined;
          const expectedParentId = parentPlan?.existingGroupId;
          if (!current || normalizedName(current.name) !== normalizedName(planned.name) ||
              (current.parentId ?? undefined) !== expectedParentId) {
            throw new HttpError(
              409,
              `Group '${planned.name}' changed after AI analysis`,
              "ai_group_plan_stale",
              { groupId: planned.existingGroupId, groupName: planned.name },
            );
          }
        }
      }
      for (const suggestion of suggestions) {
        const located = catalog.groups
          .map((group) => ({ group, item: group.items.find((item) => item.id === suggestion.itemId) }))
          .find((entry) => entry.item);
        if (!located?.item) {
          throw new HttpError(404, `Item '${suggestion.itemId}' does not exist`, "item_not_found");
        }
        const current = suggestion.field === "groupId" ? located.group.id
          : suggestion.field === "title" ? located.item.title
            : suggestion.field === "description" ? located.item.description ?? null
              : located.item.tags ?? null;
        if (JSON.stringify(current) !== JSON.stringify(suggestion.currentValue)) {
          throw new HttpError(
            409,
            `Item '${suggestion.itemId}' changed after AI analysis`,
            "ai_suggestion_stale",
            { itemId: suggestion.itemId, field: suggestion.field },
          );
        }
      }
      const planDestinations = new Map<string, CatalogGroup>();
      if (options.groupPlan) {
        const planById = new Map(options.groupPlan.groups.map((group) => [group.id, group]));
        const needed = new Set(suggestions.map((suggestion) => suggestion.planGroupId).filter((id): id is string => !!id));
        for (const id of [...needed]) {
          let current = planById.get(id);
          while (current?.parentPlanGroupId) {
            needed.add(current.parentPlanGroupId);
            current = planById.get(current.parentPlanGroupId);
          }
        }
        const ordered = options.groupPlan.groups.filter((group) => needed.has(group.id))
          .sort((left, right) => Number(Boolean(left.parentPlanGroupId)) - Number(Boolean(right.parentPlanGroupId)));
        for (const planned of ordered) {
          let destination = planned.existingGroupId
            ? catalog.groups.find((group) => group.id === planned.existingGroupId)
            : undefined;
          const parent = planned.parentPlanGroupId ? planDestinations.get(planned.parentPlanGroupId) : undefined;
          if (!destination) {
            destination = catalog.groups.find((group) => group.parentId === parent?.id && normalizedName(group.name) === normalizedName(planned.name));
          }
          if (!destination) {
            destination = {
              id: randomUUID(), name: planned.name,
              ...(parent ? { parentId: parent.id } : {}),
              itemCount: 0, items: [],
            };
            catalog.groups.push(destination);
          }
          planDestinations.set(planned.id, destination);
        }
      }
      const createdGroups = new Map<string, CatalogGroup>();
      for (const suggestion of suggestions) {
        const located = catalog.groups
          .map((group) => ({ group, item: group.items.find((item) => item.id === suggestion.itemId) }))
          .find((entry) => entry.item);
        if (!located?.item) {
          throw new HttpError(404, `Item '${suggestion.itemId}' does not exist`, "item_not_found");
        }
        const { item } = located;
        if (suggestion.field === "title") {
          if (typeof suggestion.suggestedValue !== "string") {
            throw new HttpError(400, "AI title suggestion must be a string", "invalid_ai_suggestion");
          }
          item.title = suggestion.suggestedValue;
        } else if (suggestion.field === "description") {
          if (typeof suggestion.suggestedValue !== "string") {
            throw new HttpError(400, "AI description suggestion must be a string", "invalid_ai_suggestion");
          }
          if (suggestion.suggestedValue) item.description = suggestion.suggestedValue;
          else delete item.description;
        } else if (suggestion.field === "tags") {
          if (!Array.isArray(suggestion.suggestedValue)) {
            throw new HttpError(400, "AI tags suggestion must be an array", "invalid_ai_suggestion");
          }
          if (suggestion.suggestedValue.length) item.tags = clone(suggestion.suggestedValue);
          else delete item.tags;
        } else {
          if (typeof suggestion.suggestedValue !== "string") {
            throw new HttpError(400, "AI group suggestion must be a string", "invalid_ai_suggestion");
          }
          let destination: CatalogGroup | undefined;
          if (suggestion.planGroupId && planDestinations.has(suggestion.planGroupId)) {
            destination = planDestinations.get(suggestion.planGroupId);
          } else if (suggestion.createsGroup) {
            const name = suggestion.suggestedValue;
            destination = createdGroups.get(name.toLowerCase()) ?? catalog.groups.find(
              (group) => group.name.toLowerCase() === name.toLowerCase(),
            );
            if (!destination) {
              destination = { id: randomUUID(), name, itemCount: 0, items: [] };
              catalog.groups.push(destination);
            }
            createdGroups.set(name.toLowerCase(), destination);
          } else {
            destination = catalog.groups.find((group) => group.id === suggestion.suggestedValue);
          }
          if (!destination) {
            throw new HttpError(400, "AI suggestion references an unknown group", "invalid_ai_suggestion");
          }
          if (located.group.id !== destination.id) {
            located.group.items.splice(located.group.items.indexOf(item), 1);
            destination.items.push(item);
            located.group.itemCount = located.group.items.length;
            destination.itemCount = destination.items.length;
          }
        }
      }
      const retire = new Set(options.retireEmptyGroupIds ?? []);
      if (retire.size) {
        const removable = new Set<string>();
        let changed = true;
        while (changed) {
          changed = false;
          for (const group of catalog.groups) {
            if (!retire.has(group.id) || removable.has(group.id) || group.items.length > 0) continue;
            const hasRemainingChild = catalog.groups.some((candidate) => candidate.parentId === group.id && !removable.has(candidate.id));
            if (!hasRemainingChild) {
              removable.add(group.id);
              changed = true;
            }
          }
        }
        catalog.groups = catalog.groups.filter((group) => !removable.has(group.id));
        if (catalog.groups.length === 0) {
          throw new HttpError(400, "AI regrouping cannot remove every group", "invalid_ai_suggestion");
        }
      }
    });
    return {
      status: "applied",
      beforeVersion: receipt.before.version,
      afterVersion: receipt.after.version,
      appliedSuggestionIds: suggestions.map(({ id }) => id),
      skippedSuggestionIds: [],
      conflicts: [],
      operations: operationsForSuggestions(receipt.before, receipt.after, suggestions),
      backupId: receipt.backupId,
      appliedAt: new Date().toISOString(),
    };
  }

  async applyAiChangeSet(
    jobId: string,
    suggestions: readonly AiSuggestion[],
    options: {
      retireEmptyGroupIds?: readonly string[];
      groupPlan?: AiGroupPlan;
      conflictResolutions?: Readonly<Record<string, "keep_current" | "apply_suggestion">>;
      actor?: string;
    } = {},
  ): Promise<AiApplyResult> {
    const current = await this.getCatalog();
    const resolutions = options.conflictResolutions ?? {};
    const conflicts: AiApplyConflict[] = [];
    const applicable: AiSuggestion[] = [];
    const skipped: string[] = [];
    for (const suggestion of suggestions) {
      const actual = currentSuggestionValue(current, suggestion);
      if (valuesMatch(actual, suggestion.currentValue)) {
        applicable.push(suggestion);
        continue;
      }
      const resolution = resolutions[suggestion.id] ?? "unresolved";
      conflicts.push({
        suggestionId: suggestion.id,
        itemId: suggestion.itemId,
        field: suggestion.field,
        analysisValue: clone(suggestion.currentValue),
        currentValue: clone(actual),
        suggestedValue: clone(suggestion.suggestedValue),
        resolution,
      });
      if (resolution === "apply_suggestion") {
        applicable.push({ ...clone(suggestion), currentValue: clone(actual) });
      } else {
        skipped.push(suggestion.id);
      }
    }
    if (!applicable.length) {
      return {
        status: "conflicts", beforeVersion: current.version, afterVersion: current.version,
        appliedSuggestionIds: [], skippedSuggestionIds: skipped, conflicts, operations: [],
      };
    }
    const applied = await this.applyAiSuggestions(applicable, options);
    const changeSetId = randomUUID();
    const result: AiApplyResult = {
      ...applied,
      changeSetId,
      status: skipped.length ? "partially_applied" : "applied",
      skippedSuggestionIds: skipped,
      conflicts,
    };
    await this.writeChangeSet({
      schemaVersion: 1, changeSetId, jobId, actor: options.actor ?? "administrator",
      ...result,
    });
    return result;
  }

  async restoreAiChangeSet(
    changeSetId: string,
    expectedVersion: string,
    actor = "administrator",
  ): Promise<AiRestoreResult> {
    if (!/^[a-f\d-]{36}$/i.test(changeSetId)) {
      throw new HttpError(400, "Invalid change set id", "invalid_request");
    }
    return this.enqueue(async () => {
      const manifest = JSON.parse(await readFile(this.changeSetPath(changeSetId), "utf8")) as AiApplyResult;
      if (!manifest.backupId || basename(manifest.backupId) !== manifest.backupId) {
        throw new HttpError(500, "Change set backup is invalid", "ai_changeset_corrupt");
      }
      const current = await this.getCatalog();
      if (current.version !== expectedVersion) {
        throw new HttpError(409, "Catalog changed; refresh before restoring", "version_conflict", {
          expectedVersion, currentVersion: current.version,
        });
      }
      const backupText = await readFile(join(this.options.backupDir, manifest.backupId), "utf8");
      const backupValue = JSON.parse(backupText) as { version?: unknown };
      const restored = normalizeCatalog(backupValue, false);
      if (backupValue.version !== restored.version) {
        throw new HttpError(500, "Change set backup hash is invalid", "ai_changeset_corrupt");
      }
      if (restored.version !== manifest.beforeVersion) {
        throw new HttpError(500, "Change set backup does not match its manifest", "ai_changeset_corrupt");
      }
      const safetyBackupId = await this.backupCurrent();
      await CatalogStore.atomicReplace(this.options.catalogPath, restored);
      const result: AiRestoreResult = {
        changeSetId, restoredAt: new Date().toISOString(), beforeVersion: current.version,
        restoredVersion: restored.version, safetyBackupId,
      };
      await this.writeChangeSet({ schemaVersion: 1, type: "restore", actor, ...result }, `${changeSetId}.restore.${randomUUID()}`);
      return result;
    });
  }

  async applyHealthChangeSet(
    scanJobId: string,
    actions: readonly HealthAction[],
    actor = "administrator",
  ): Promise<HealthChangeSetResult> {
    let outcome: ReturnType<typeof applyHealthActionsToCatalog> = { operations: [], conflicts: [] };
    const preview = clone(await this.getCatalog());
    const previewOutcome = applyHealthActionsToCatalog(preview, actions);
    if (!previewOutcome.operations.length) {
      const version = (await this.getCatalog()).version;
      return { status: "conflicts", beforeVersion: version, afterVersion: version, ...previewOutcome };
    }
    const receipt = await this.mutate((catalog) => {
      outcome = applyHealthActionsToCatalog(catalog, actions);
    });
    const changeSetId = randomUUID();
    const result: HealthChangeSetResult = {
      changeSetId,
      status: outcome.conflicts.length ? "partially_applied" : "applied",
      beforeVersion: receipt.before.version,
      afterVersion: receipt.after.version,
      operations: outcome.operations,
      conflicts: outcome.conflicts,
      backupId: receipt.backupId,
      appliedAt: new Date().toISOString(),
    };
    await this.writeChangeSet({
      schemaVersion: 1, type: "health", changeSetId, scanJobId, actor, ...result,
    });
    return result;
  }

  async replaceCatalogWithChangeSet(
    kind: CatalogReplacementResult["kind"],
    expectedVersion: string,
    nextCatalog: DashyCatalog,
    actor = "administrator",
  ): Promise<CatalogReplacementResult> {
    return this.enqueue(async () => {
      const current = await this.getCatalog();
      if (current.version !== expectedVersion) {
        throw new HttpError(409, "Catalog changed; refresh before importing", "version_conflict", {
          expectedVersion, currentVersion: current.version,
        });
      }
      const normalized = normalizeCatalog(nextCatalog, false);
      const backupId = await this.backupCurrent();
      await CatalogStore.atomicReplace(this.options.catalogPath, normalized);
      const result: CatalogReplacementResult = {
        changeSetId: randomUUID(), kind, beforeVersion: current.version, afterVersion: normalized.version,
        backupId, appliedAt: new Date().toISOString(),
      };
      await this.writeChangeSet({ schemaVersion: 1, type: kind, actor, ...result });
      return result;
    });
  }

  private async mutate(mutation: CatalogMutation): Promise<CatalogMutationReceipt> {
    return this.enqueue(async () => {
      const catalog = await this.getCatalog();
      const before = clone(catalog);
      mutation(catalog);
      const normalized = normalizeCatalog(catalog, false);
      const backupId = await this.backupCurrent();
      await CatalogStore.atomicReplace(this.options.catalogPath, normalized);
      return { before, after: normalized, backupId };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async backupCurrent(): Promise<string> {
    await mkdir(this.options.backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(
      this.options.backupDir,
      `${basename(this.options.catalogPath, ".json")}-${timestamp}-${randomUUID()}.json`,
    );
    await copyFile(this.options.catalogPath, path);
    return basename(path);
  }

  private changeSetPath(id: string): string {
    return join(this.options.backupDir, "ai-changesets", `${id}.json`);
  }

  private async writeChangeSet(value: unknown, id = (value as { changeSetId: string }).changeSetId): Promise<void> {
    const path = this.changeSetPath(id);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new HttpError(409, "Change set already exists", "ai_changeset_exists");
      throw error;
    });
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private static async atomicReplace(path: string, catalog: DashyCatalog): Promise<void> {
    const directory = dirname(path);
    const tempPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    const content = `${JSON.stringify(catalog, null, 2)}\n`;
    let handle;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tempPath, path);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}

function currentSuggestionValue(
  catalog: DashyCatalog,
  suggestion: AiSuggestion,
): string | string[] | null {
  const located = catalog.groups
    .map((group) => ({ group, item: group.items.find((item) => item.id === suggestion.itemId) }))
    .find(({ item }) => Boolean(item));
  if (!located?.item) {
    throw new HttpError(404, `Item '${suggestion.itemId}' does not exist`, "item_not_found");
  }
  if (suggestion.field === "groupId") return located.group.id;
  if (suggestion.field === "title") return located.item.title;
  if (suggestion.field === "description") return located.item.description ?? null;
  return clone(located.item.tags ?? null);
}

function valuesMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function operationsForSuggestions(
  before: DashyCatalog,
  after: DashyCatalog,
  suggestions: readonly AiSuggestion[],
): AiChangeOperation[] {
  const operations: AiChangeOperation[] = suggestions.map((suggestion) => ({
    type: suggestion.field === "groupId" ? "item_move" : "item_field",
    itemId: suggestion.itemId,
    field: suggestion.field,
    before: clone(suggestion.currentValue),
    after: clone(suggestion.suggestedValue),
  }));
  const beforeGroups = new Map(before.groups.map((group) => [group.id, group]));
  const afterGroups = new Map(after.groups.map((group) => [group.id, group]));
  for (const group of after.groups) {
    if (!beforeGroups.has(group.id)) {
      operations.push({ type: "group_create", groupId: group.id, after: { name: group.name, parentId: group.parentId } });
    }
  }
  for (const group of before.groups) {
    if (!afterGroups.has(group.id)) {
      operations.push({ type: "group_delete", groupId: group.id, before: { name: group.name, parentId: group.parentId } });
    }
  }
  return operations;
}
