import type { HealthFindingKind, HealthJob, HealthRemoteCategory } from "./health-types.js";

export interface HealthSummary {
  schemaVersion: 1;
  jobId: string | null;
  jobStatus: string | null;
  completedAt: string | null;
  catalogVersion: string | null;
  scope: { type: "all" } | { type: "groups"; ids: string[] } | null;
  counts: {
    duplicates: number;
    deadLinks: number;
    brokenLinks: number;
    redirects: number;
    authRequired: number;
    missingMetadata: number;
    emptyGroups: number;
  };
}

const DUPLICATE_KINDS: ReadonlySet<HealthFindingKind> = new Set([
  "exact_duplicate", "suspected_duplicate", "duplicate_title",
]);

const DEAD_CATEGORIES: ReadonlySet<HealthRemoteCategory> = new Set(["not_found"]);
const BROKEN_CATEGORIES: ReadonlySet<HealthRemoteCategory> = new Set(["timeout", "dns_error", "other_error"]);
const REDIRECT_CATEGORIES: ReadonlySet<HealthRemoteCategory> = new Set(["permanent_redirect", "temporary_redirect"]);

/** 从健康任务明细计算公开摘要计数；无任务时返回全零摘要。 */
export function summarizeHealthJobs(jobs: Iterable<HealthJob>): HealthSummary {
  let latest: HealthJob | null = null;
  for (const job of jobs) {
    if (job.status !== "completed") continue;
    if (!latest || job.updatedAt.localeCompare(latest.updatedAt) > 0) latest = job;
  }

  const empty: HealthSummary = {
    schemaVersion: 1,
    jobId: null,
    jobStatus: null,
    completedAt: null,
    catalogVersion: null,
    scope: null,
    counts: { duplicates: 0, deadLinks: 0, brokenLinks: 0, redirects: 0, authRequired: 0, missingMetadata: 0, emptyGroups: 0 },
  };
  if (!latest) return empty;

  const counts = { ...empty.counts };
  for (const finding of latest.findings ?? []) {
    if (DUPLICATE_KINDS.has(finding.kind)) counts.duplicates += 1;
    else if (finding.kind === "missing_metadata") counts.missingMetadata += 1;
    else if (finding.kind === "empty_group") counts.emptyGroups += 1;
  }
  for (const result of latest.remoteResults ?? []) {
    if (DEAD_CATEGORIES.has(result.category)) counts.deadLinks += 1;
    else if (BROKEN_CATEGORIES.has(result.category)) counts.brokenLinks += 1;
    else if (REDIRECT_CATEGORIES.has(result.category)) counts.redirects += 1;
    else if (result.category === "auth_required") counts.authRequired += 1;
  }

  return {
    schemaVersion: 1,
    jobId: latest.id,
    jobStatus: latest.status,
    completedAt: latest.completedAt ?? latest.updatedAt,
    catalogVersion: latest.catalogVersion,
    scope: latest.scope,
    counts,
  };
}
