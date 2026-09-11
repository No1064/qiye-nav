import { randomUUID } from "node:crypto";
import { objectValue } from "./ai-job-input.js";
import { existingGroupsForPlan, normalizedName, type TopicCandidate, type WorkItem } from "./ai-job-model.js";
import { HttpError } from "./errors.js";
import type { AiField, AiGroupPlan, AiGroupPlanEntry, AiJob, AiSuggestion, DashyCatalog } from "./types.js";

export function parseTopicCandidatesPartial(
  content: string,
  batch: WorkItem[],
): { candidates: TopicCandidate[]; acceptedCount: number; missingItemIds: string[] } {
  const root = parseJsonObject(content);
  if (Object.keys(root).some((key) => key !== "topics") || !Array.isArray(root.topics) ||
      root.topics.length < 1 || root.topics.length > 16) {
    throw invalidResponse("AI topic extraction must return non-empty clusters");
  }
  const known = new Map(batch.map(({ item }) => [item.id, item]));
  const assigned = new Set<string>();
  const topics: TopicCandidate[] = [];
  for (const raw of root.topics) {
    const input = objectValue(raw);
    const allowed = new Set(["name", "description", "reason", "confidence", "itemIds"]);
    if (Object.keys(input).some((key) => !allowed.has(key)) || !Array.isArray(input.itemIds) || input.itemIds.length === 0) {
      throw invalidResponse("AI topic contains invalid fields");
    }
    const itemIds: string[] = [];
    for (const id of input.itemIds) {
      if (typeof id !== "string" || !known.has(id) || assigned.has(id)) continue;
      assigned.add(id);
      itemIds.push(id);
    }
    if (!itemIds.length) continue;
    const name = limitedText(input.name, 100, false, "AI group name is invalid");
    const description = limitedText(input.description, 300, true, "AI group description is invalid");
    const reason = limitedText(input.reason, 500, false, "AI group reason is invalid");
    const confidence = validConfidence(input.confidence);
    topics.push({ name, description, reason, confidence, itemIds, sampleTitles: itemIds.slice(0, 5).map((id) => known.get(id)!.title) });
  }
  return {
    candidates: topics,
    acceptedCount: assigned.size,
    missingItemIds: batch.map(({ item }) => item.id).filter((id) => !assigned.has(id)),
  };
}

function parseTopicCandidates(content: string, batch: WorkItem[]): TopicCandidate[] {
  const parsed = parseTopicCandidatesPartial(content, batch);
  if (parsed.missingItemIds.length) throw invalidResponse("AI topic extraction omitted an item");
  return parsed.candidates;
}

export function parseGroupPlan(content: string, catalog: DashyCatalog, job: AiJob, items: WorkItem[]): AiGroupPlan {
  const root = parseJsonObject(content);
  if (Object.keys(root).some((key) => !["summary", "groups"].includes(key)) || !Array.isArray(root.groups) || root.groups.length === 0 || root.groups.length > 100) {
    throw invalidResponse("AI target group plan has an invalid schema");
  }
  const summary = limitedText(root.summary, 1_000, false, "AI group plan summary is invalid");
  const lowerBound = Math.max(1, Math.floor(job.groupingOptions.targetGroupCount * 0.65));
  const upperBound = Math.max(1, Math.ceil(job.groupingOptions.targetGroupCount * 1.35));
  const hardLowerBound = Math.max(1, Math.floor(job.groupingOptions.targetGroupCount * 0.55));
  const hardUpperBound = Math.max(1, Math.ceil(job.groupingOptions.targetGroupCount * 1.5));
  const seenKeys = new Set<string>();
  const seenExisting = new Set<string>();
  const parsed = root.groups.map((raw, index) => {
    const input = objectValue(raw);
    const allowed = new Set(["key", "name", "parentKey", "description", "existingGroupId", "reason", "confidence"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw invalidResponse("AI target group contains unknown fields");
    const name = limitedText(input.name, 100, false, "AI target group name is invalid");
    const key = typeof input.key === "string"
      ? limitedText(input.key, 80, false, "AI target group key is invalid")
      : `group-${index + 1}`;
    if (seenKeys.has(key)) throw invalidResponse("AI target group keys must be unique");
    seenKeys.add(key);
    const parentKey = input.parentKey === null || input.parentKey === undefined
      ? undefined
      : limitedText(input.parentKey, 80, false, "AI target parent key is invalid");
    let existingGroupId: string | undefined;
    if (input.existingGroupId !== null && input.existingGroupId !== undefined) {
      const existing = typeof input.existingGroupId === "string"
        ? catalog.groups.find((group) => group.id === input.existingGroupId)
        : undefined;
      const canReuse = job.groupStrategy !== "rebuild" && existing &&
        !seenExisting.has(input.existingGroupId as string) &&
        normalizedName(existing.name) === normalizedName(name);
      if (canReuse) {
        existingGroupId = input.existingGroupId as string;
        seenExisting.add(existingGroupId);
      }
    }
    return {
      key, parentKey,
      id: randomUUID(), name, description: limitedText(input.description, 300, true, "AI target group description is invalid"),
      ...(existingGroupId ? { existingGroupId } : {}), sourceGroupIds: [],
      reason: limitedText(input.reason, 500, false, "AI target group reason is invalid"),
      confidence: validConfidence(input.confidence), itemCount: 0,
    };
  });
  const byKey = new Map(parsed.map((group) => [group.key, group]));
  const siblingNames = new Set<string>();
  const groups: AiGroupPlanEntry[] = parsed.map((group) => {
    const parent = group.parentKey ? byKey.get(group.parentKey) : undefined;
    if (group.parentKey && (!parent || parent.id === group.id || parent.parentKey)) {
      throw invalidResponse("AI target groups support only two valid levels");
    }
    const siblingKey = `${group.parentKey ?? "root"}\u0000${normalizedName(group.name)}`;
    if (siblingNames.has(siblingKey)) throw invalidResponse("AI target sibling group names must be unique");
    siblingNames.add(siblingKey);
    if (group.existingGroupId) {
      const existing = catalog.groups.find((candidate) => candidate.id === group.existingGroupId)!;
      if ((existing.parentId ?? null) !== (parent?.existingGroupId ?? null)) {
        seenExisting.delete(group.existingGroupId);
        delete group.existingGroupId;
      }
    }
    const { key: _key, parentKey: _parentKey, ...entry } = group;
    return { ...entry, ...(parent ? { parentPlanGroupId: parent.id } : {}) };
  });
  const leafCount = groups.filter((group) => !groups.some((candidate) => candidate.parentPlanGroupId === group.id)).length;
  if (leafCount < hardLowerBound || leafCount > hardUpperBound) {
    throw invalidResponse(`AI target leaf group count must be between ${hardLowerBound} and ${hardUpperBound}; received ${leafCount}`);
  }
  const warnings = leafCount < lowerBound || leafCount > upperBound
    ? [`模型建议 ${leafCount} 个叶子分组，超出目标建议范围 ${lowerBound}-${upperBound}，已保留供人工审核。`]
    : undefined;
  const leafIds = new Set(groups.filter((group) => !groups.some((candidate) => candidate.parentPlanGroupId === group.id)).map((group) => group.id));
  if (job.groupStrategy === "reorganize" && items.length >= 20 && groups.filter((group) => leafIds.has(group.id)).every(({ existingGroupId }) => existingGroupId)) {
    throw invalidResponse("Balanced regrouping must contain at least one new group");
  }
  const selectedGroupIds = new Set(items.map(({ groupId }) => groupId));
  return {
    summary, ...(warnings ? { warnings } : {}), targetGroupCount: job.groupingOptions.targetGroupCount, groups,
    retireGroupIds: [...selectedGroupIds].filter((id) => !seenExisting.has(id)),
  };
}

export function parseDecisions(content: string, catalog: DashyCatalog, job: AiJob, batch: WorkItem[]): AiSuggestion[] {
  const root = parseJsonObject(content);
  if (Object.keys(root).some((key) => key !== "items") || !Array.isArray(root.items) || root.items.length !== batch.length) {
    throw invalidResponse("AI response must contain one decision set for every item");
  }
  const batchById = new Map(batch.map((entry) => [entry.item.id, entry]));
  const seen = new Set<string>();
  const output: AiSuggestion[] = [];
  for (const raw of root.items) {
    const itemResult = objectValue(raw);
    if (Object.keys(itemResult).some((key) => !["itemId", "decisions"].includes(key)) ||
        typeof itemResult.itemId !== "string" || !batchById.has(itemResult.itemId) || seen.has(itemResult.itemId)) {
      throw invalidResponse("AI response contains an unknown or duplicate item");
    }
    seen.add(itemResult.itemId);
    const decisions = objectValue(itemResult.decisions);
    if (Object.keys(decisions).length !== job.fields.length ||
        job.fields.some((field) => !(field in decisions)) ||
        Object.keys(decisions).some((field) => !job.fields.includes(field as AiField))) {
      throw invalidResponse("AI response omitted or added a requested field decision");
    }
    const entry = batchById.get(itemResult.itemId)!;
    for (const field of job.fields) output.push(parseFieldDecision(decisions[field], field, entry, catalog, job));
  }
  if (seen.size !== batch.length) throw invalidResponse("AI response omitted an item");
  return output;
}

function parseFieldDecision(
  raw: unknown, field: AiField, entry: WorkItem, catalog: DashyCatalog, job: AiJob,
): AiSuggestion {
  const input = objectValue(raw);
  const reason = limitedText(input.reason, 500, false, "AI decision reason is invalid");
  const confidence = validConfidence(input.confidence);
  const currentValue = field === "groupId" ? entry.groupId
    : field === "title" ? entry.item.title
      : field === "description" ? entry.item.description ?? null : entry.item.tags ?? null;
  let suggestedValue: string | string[] = currentValue === null ? "" : structuredClone(currentValue);
  let createsGroup = false;
  let keep = input.action === "keep";
  if (field === "groupId") {
    const allowed = new Set(["action", "groupId", "planGroupId", "reason", "confidence"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw invalidResponse("AI group decision is invalid");
    if (job.groupPlan) {
      if (input.action !== "assign" || typeof input.planGroupId !== "string") {
        throw invalidResponse("AI must assign every item to the target group plan");
      }
      const target = job.groupPlan.groups.find(({ id }) => id === input.planGroupId);
      if (!target) throw invalidResponse("AI assignment references an unknown planned group");
      if (job.groupPlan.groups.some((candidate) => candidate.parentPlanGroupId === target.id)) {
        throw invalidResponse("AI must assign websites to a leaf project group");
      }
      if (target.existingGroupId) suggestedValue = target.existingGroupId;
      else {
        suggestedValue = target.name;
        createsGroup = true;
      }
      keep = !createsGroup && suggestedValue === entry.groupId;
    } else if (!["keep", "move"].includes(String(input.action))) {
      throw invalidResponse("AI group decision is invalid");
    } else if (input.action === "move") {
      if (typeof input.groupId !== "string" || !existingGroupsForPlan(catalog, job).some((group) => group.id === input.groupId)) {
        throw invalidResponse("AI group move references an unknown group");
      }
      suggestedValue = input.groupId;
    }
  } else {
    const allowed = new Set(["action", "value", "reason", "confidence"]);
    if (Object.keys(input).some((key) => !allowed.has(key)) || !["keep", "change"].includes(String(input.action))) {
      throw invalidResponse("AI field decision is invalid");
    }
    if (input.action === "change") suggestedValue = validateFieldValue(input.value, field);
  }
  if (job.missingOnly && (Array.isArray(currentValue) ? currentValue.length > 0 : typeof currentValue === "string" && currentValue.trim().length > 0)) {
    suggestedValue = structuredClone(currentValue!);
    keep = true;
  }
  if (!keep && valuesEqual(currentValue, suggestedValue, field)) keep = true;
  return {
    id: randomUUID(), groupId: entry.groupId, itemId: entry.item.id, field,
    currentValue: structuredClone(currentValue), suggestedValue, reason, confidence,
    status: keep ? "kept" : "pending", createsGroup,
    ...(field === "groupId" && job.groupPlan && typeof input.planGroupId === "string" ? { planGroupId: input.planGroupId } : {}),
  };
}

function validateFieldValue(value: unknown, field: Exclude<AiField, "groupId">): string | string[] {
  if (field === "tags") {
    if (!Array.isArray(value) || value.length > 20 || value.some((tag) => typeof tag !== "string" || !tag.trim() || tag.trim().length > 50)) {
      throw invalidResponse("AI tags decision is invalid");
    }
    const tags = [...new Set(value.map((tag) => (tag as string).trim()))];
    if (tags.length !== value.length) throw invalidResponse("AI tags decision contains duplicates");
    return tags;
  }
  return limitedText(value, field === "title" ? 300 : 1_000, field === "description", "AI text decision is invalid");
}

function parseJsonObject(content: string): Record<string, unknown> {
  try { return objectValue(JSON.parse(content)); } catch (error) {
    if (error instanceof HttpError && error.code === "invalid_request") throw invalidResponse("AI response is not a JSON object");
    throw invalidResponse("AI response is not valid JSON");
  }
}

function limitedText(value: unknown, maximum: number, allowEmpty: boolean, message: string): string {
  if (typeof value !== "string") throw invalidResponse(message);
  const normalized = value.trim().replace(/\s+/g, " ");
  if ((!allowEmpty && !normalized) || normalized.length > maximum) throw invalidResponse(message);
  return normalized;
}

function validConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidResponse("AI confidence is invalid");
  }
  return value;
}

export function invalidResponse(message: string): HttpError {
  return new HttpError(502, message, "ai_invalid_response");
}

function valuesEqual(current: string | string[] | null, suggested: string | string[], field: AiField): boolean {
  if (field === "tags") {
    const left = Array.isArray(current) ? current.map((value) => value.trim().toLocaleLowerCase()).sort() : [];
    const right = Array.isArray(suggested) ? suggested.map((value) => value.trim().toLocaleLowerCase()).sort() : [];
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return String(current ?? "").trim().replace(/\s+/g, " ") === String(suggested).trim().replace(/\s+/g, " ");
}
