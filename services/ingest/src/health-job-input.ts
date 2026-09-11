import { HttpError } from "./errors.js";
import type { HealthJobScope } from "./health-types.js";

export interface CreateHealthJobInput {
  includeRemote: boolean;
  scope: HealthJobScope;
}

export function parseCreateHealthJob(value: unknown): CreateHealthJobInput {
  if (value === undefined) return { includeRemote: true, scope: { type: "all" } };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Request body must be an object");
  const input = value as Record<string, unknown>;
  if (input.includeRemote !== undefined && typeof input.includeRemote !== "boolean") {
    invalid("includeRemote must be a boolean");
  }
  return { includeRemote: input.includeRemote !== false, scope: parseHealthScope(input.scope) };
}

export function parseHealthScope(value: unknown): HealthJobScope {
  // Preserve compatibility with clients created before scoped health scans.
  if (value === undefined) return { type: "all" };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("scope must be an object");
  const scope = value as Record<string, unknown>;
  if (scope.type === "all") {
    if (scope.ids !== undefined) invalid("scope.ids is not allowed for all scope");
    return { type: "all" };
  }
  if (scope.type !== "groups") invalid("scope.type must be all or groups");
  if (!Array.isArray(scope.ids) || scope.ids.length < 1 || scope.ids.length > 100) {
    invalid("scope.ids must contain 1-100 group ids");
  }
  const ids = scope.ids.map((id) => {
    if (typeof id !== "string" || !id.trim() || id.length > 200) invalid("scope.ids contains an invalid group id");
    return id.trim();
  });
  if (new Set(ids).size !== ids.length) invalid("scope.ids must not contain duplicates");
  return { type: "groups", ids };
}

function invalid(message: string): never { throw new HttpError(400, message, "invalid_request"); }
