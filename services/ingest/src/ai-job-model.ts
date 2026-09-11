import { HttpError } from "./errors.js";
import type {
  AiGroupingOptions,
  AiGroupStrategy,
  AiJob,
  AiJobScope,
  CatalogGroup,
  CatalogItem,
  DashyCatalog,
} from "./types.js";

export interface WorkItem { groupId: string; groupName: string; item: CatalogItem }

export interface TopicCandidate {
  name: string;
  description: string;
  reason: string;
  confidence: number;
  itemIds: string[];
  sampleTitles: string[];
}

export function selectItems(catalog: DashyCatalog, scope: AiJobScope): WorkItem[] {
  if (scope.type === "items") {
    const ids = new Set(scope.ids);
    const items = catalog.groups.flatMap((group) => group.items.filter((item) => ids.has(item.id)).map((item) => ({ groupId: group.id, groupName: group.name, item })));
    if (items.length !== ids.size) throw new HttpError(404, "Selected bookmark no longer exists", "item_not_found");
    return items;
  }
  const groupIds = scope.type === "groups" ? scope.ids : undefined;
  const ids = groupIds ? new Set(groupIds) : undefined;
  if (groupIds) {
    const unknown = groupIds.find((id) => !catalog.groups.some((group) => group.id === id));
    if (unknown) throw new HttpError(404, `Group '${unknown}' does not exist`, "group_not_found");
    for (const group of catalog.groups) if (group.parentId && ids?.has(group.parentId)) ids.add(group.id);
  }
  return catalog.groups
    .filter((group) => !ids || ids.has(group.id))
    .flatMap((group) => group.items.map((item) => ({ groupId: group.id, groupName: group.name, item })));
}

export function catalogGroupPath(catalog: DashyCatalog, group: CatalogGroup): string {
  const parent = group.parentId ? catalog.groups.find((candidate) => candidate.id === group.parentId) : undefined;
  return parent ? `${parent.name} / ${group.name}` : group.name;
}

export function existingGroupsForPlan(catalog: DashyCatalog, job: AiJob): CatalogGroup[] {
  if (job.scope.type === "all" || (job.groupStrategy === "existing" && job.destinationScope === "all")) return catalog.groups;
  const ids = new Set(job.scope.type === "items" ? selectItems(catalog, job.scope).map((entry) => entry.groupId) : job.scope.ids);
  for (const group of catalog.groups) if (group.parentId && ids.has(group.parentId)) ids.add(group.id);
  for (const group of catalog.groups) if (group.parentId && ids.has(group.id)) ids.add(group.parentId);
  return catalog.groups.filter((group) => ids.has(group.id));
}

export function resolvedGroupingOptions(
  input: Partial<AiGroupingOptions> | undefined,
  itemCount: number,
  strategy: AiGroupStrategy,
): AiGroupingOptions {
  const minGroupSize = input?.minGroupSize ?? 5;
  const maxGroupSize = input?.maxGroupSize ?? 40;
  const automatic = strategy === "existing"
    ? 0
    : Math.max(1, Math.min(60, Math.round(Math.sqrt(Math.max(1, itemCount)) * (strategy === "rebuild" ? 1.15 : 1.4))));
  const targetGroupCount = input?.targetGroupCount ?? automatic;
  if (minGroupSize > maxGroupSize) {
    throw new HttpError(400, "minGroupSize must not exceed maxGroupSize", "invalid_request");
  }
  if (strategy !== "existing" && targetGroupCount > itemCount) {
    throw new HttpError(400, "targetGroupCount must not exceed the number of selected items", "invalid_request");
  }
  return { targetGroupCount, minGroupSize, maxGroupSize };
}

export function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
