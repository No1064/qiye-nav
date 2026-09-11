import { HttpError } from "./errors.js";
import type { AiField, AiGroupingOptions, AiGroupStrategy, AiJobScope } from "./types.js";

const FIELDS = new Set<AiField>(["title", "groupId", "description", "tags"]);

export interface CreateAiJobInput {
  scope: AiJobScope;
  fields: AiField[];
  allowNewGroups: boolean;
  groupStrategy?: AiGroupStrategy;
  destinationScope?: "selected" | "all";
  missingOnly?: boolean;
  groupingOptions?: Partial<AiGroupingOptions>;
}

export function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object", "invalid_request");
  }
  return value as Record<string, unknown>;
}

export function parseCreateAiJob(value: unknown): CreateAiJobInput {
  const input = objectValue(value);
  const scopeValue = objectValue(input.scope);
  let scope: AiJobScope;
  if (scopeValue.type === "all") scope = { type: "all" };
  else if (scopeValue.type === "groups" || scopeValue.type === "items") {
    if (!Array.isArray(scopeValue.ids) || scopeValue.ids.length < 1 || scopeValue.ids.length > (scopeValue.type === "items" ? 1000 : 100)) {
      throw new HttpError(400, "scope.ids must contain 1-100 group ids", "invalid_request");
    }
    const ids = scopeValue.ids.map((id) => {
      if (typeof id !== "string" || !id.trim() || id.length > 200) {
        throw new HttpError(400, "scope.ids contains an invalid group id", "invalid_request");
      }
      return id.trim();
    });
    if (new Set(ids).size !== ids.length) {
      throw new HttpError(400, "scope.ids must not contain duplicates", "invalid_request");
    }
    scope = { type: scopeValue.type, ids };
  } else {
    throw new HttpError(400, "scope.type must be all, groups, or items", "invalid_request");
  }
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > FIELDS.size) {
    throw new HttpError(400, "fields must contain 1-4 supported fields", "invalid_request");
  }
  const fields = input.fields.map((field) => {
    if (typeof field !== "string" || !FIELDS.has(field as AiField)) {
      throw new HttpError(400, "fields supports title, groupId, description, and tags", "invalid_request");
    }
    return field as AiField;
  });
  if (new Set(fields).size !== fields.length) {
    throw new HttpError(400, "fields must not contain duplicates", "invalid_request");
  }
  if (input.allowNewGroups !== undefined && typeof input.allowNewGroups !== "boolean") {
    throw new HttpError(400, "allowNewGroups must be a boolean", "invalid_request");
  }
  const legacyAllowsGroups = input.allowNewGroups === true;
  const groupStrategy = input.groupStrategy === undefined
    ? (legacyAllowsGroups ? "reorganize" : "existing")
    : input.groupStrategy;
  if (!["existing", "reorganize", "rebuild"].includes(String(groupStrategy))) {
    throw new HttpError(400, "groupStrategy must be existing, reorganize, or rebuild", "invalid_request");
  }
  if (input.destinationScope !== undefined && !["selected", "all"].includes(String(input.destinationScope))) {
    throw new HttpError(400, "destinationScope must be selected or all", "invalid_request");
  }
  if (input.missingOnly !== undefined && typeof input.missingOnly !== "boolean") throw new HttpError(400, "missingOnly must be a boolean", "invalid_request");
  if ((scope.type === "items" || input.missingOnly) && groupStrategy !== "existing") throw new HttpError(400, "Item selection and missing-only tasks require existing groups", "invalid_request");
  if (input.missingOnly && fields.includes("groupId")) throw new HttpError(400, "Missing-only tasks cannot move bookmarks", "invalid_request");
  const validatedStrategy = groupStrategy as AiGroupStrategy;
  if (groupStrategy !== "existing" && !fields.includes("groupId")) {
    throw new HttpError(400, "group regrouping requires the groupId field", "invalid_request");
  }
  const groupingOptions = parseGroupingOptions(input.groupingOptions);
  return {
    scope,
    fields,
    groupStrategy: validatedStrategy,
    destinationScope: input.destinationScope === "all" ? "all" : "selected",
    missingOnly: input.missingOnly === true,
    allowNewGroups: validatedStrategy !== "existing",
    groupingOptions,
  };
}

function parseGroupingOptions(value: unknown): Partial<AiGroupingOptions> {
  if (value === undefined) return {};
  const input = objectValue(value);
  const allowed = new Set(["targetGroupCount", "minGroupSize", "maxGroupSize"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new HttpError(400, "groupingOptions contains unknown fields", "invalid_request");
  }
  const result: Partial<AiGroupingOptions> = {};
  for (const [key, minimum, maximum] of [
    ["targetGroupCount", 1, 100], ["minGroupSize", 2, 50], ["maxGroupSize", 5, 200],
  ] as const) {
    if (input[key] === undefined) continue;
    if (!Number.isInteger(input[key]) || (input[key] as number) < minimum || (input[key] as number) > maximum) {
      throw new HttpError(400, `${key} is invalid`, "invalid_request");
    }
    result[key] = input[key] as number;
  }
  if (result.minGroupSize && result.maxGroupSize && result.minGroupSize > result.maxGroupSize) {
    throw new HttpError(400, "minGroupSize must not exceed maxGroupSize", "invalid_request");
  }
  return result;
}

export function parseSuggestionIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const input = objectValue(value);
  if (input.suggestionIds === undefined) return undefined;
  if (!Array.isArray(input.suggestionIds) || input.suggestionIds.length > 5_000) {
    throw new HttpError(400, "suggestionIds must be an array", "invalid_request");
  }
  const ids = input.suggestionIds.map((id) => {
    if (typeof id !== "string" || !id.trim() || id.length > 200) {
      throw new HttpError(400, "suggestionIds contains an invalid id", "invalid_request");
    }
    return id.trim();
  });
  if (new Set(ids).size !== ids.length) {
    throw new HttpError(400, "suggestionIds must not contain duplicates", "invalid_request");
  }
  return ids;
}

export function parseRetireGroupIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const input = objectValue(value);
  if (input.retireGroupIds === undefined) return undefined;
  if (!Array.isArray(input.retireGroupIds) || input.retireGroupIds.length > 100 ||
      input.retireGroupIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 200)) {
    throw new HttpError(400, "retireGroupIds must be an array of group ids", "invalid_request");
  }
  const ids = input.retireGroupIds.map((id) => (id as string).trim());
  if (new Set(ids).size !== ids.length) throw new HttpError(400, "retireGroupIds must not contain duplicates", "invalid_request");
  return ids;
}
