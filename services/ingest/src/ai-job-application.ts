import { HttpError } from "./errors.js";
import type { AiApplyResult, AiJob, AiSuggestion } from "./types.js";

export function suggestionsToApply(job: AiJob, ids?: string[]): AiSuggestion[] {
  if (!["completed", "partial"].includes(job.status)) {
    throw new HttpError(409, "AI job is not ready to apply", "ai_job_not_ready");
  }
  const wanted = ids ? new Set(ids) : undefined;
  if (wanted) {
    const known = new Set(job.suggestions.filter(({ status }) => status === "pending").map(({ id }) => id));
    const unknown = ids?.find((suggestionId) => !known.has(suggestionId));
    if (unknown) throw new HttpError(404, `Suggestion '${unknown}' does not exist`, "ai_suggestion_not_found");
  }
  const selected = job.suggestions.filter(
    (suggestion) => suggestion.status === "pending" && (!wanted || wanted.has(suggestion.id)),
  );
  if (!selected.length) {
    throw new HttpError(409, "No pending suggestions were selected", "no_pending_suggestions");
  }
  return structuredClone(selected);
}

export function retireGroupsToApply(job: AiJob, requested?: string[]): string[] {
  const allowed = new Set(job.groupPlan?.retireGroupIds ?? []);
  const ids = requested ?? [];
  const unknown = ids.find((groupId) => !allowed.has(groupId));
  if (unknown) throw new HttpError(400, `Group '${unknown}' is not in the AI retirement plan`, "invalid_request");
  return [...ids];
}

export function markApplied(
  job: AiJob,
  ids: readonly string[],
  now: number,
  result?: AiApplyResult,
): void {
  const wanted = new Set(ids);
  const appliedAt = new Date(now).toISOString();
  for (const suggestion of job.suggestions) {
    if (wanted.has(suggestion.id)) {
      suggestion.status = "applied";
      suggestion.appliedAt = appliedAt;
    }
  }
  job.appliedAt = appliedAt;
  job.appliedCount = (job.appliedCount ?? 0) + ids.length;
  const pending = job.suggestions.some(({ status }) => status === "pending");
  job.lifecycleStatus = pending ? "partially_applied" : "applied";
  job.phase = pending ? "review" : "applied";
  job.updatedAt = appliedAt;
  if (result?.changeSetId) {
    job.applyHistory ??= [];
    if (!job.applyHistory.some(({ changeSetId }) => changeSetId === result.changeSetId)) {
      job.applyHistory.push(structuredClone(result));
    }
  }
}
