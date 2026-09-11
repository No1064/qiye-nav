import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { resolvedGroupingOptions } from "./ai-job-model.js";
import type { AiField, AiJob, AiJobSummary, AiSuggestion } from "./types.js";

export const GROUP_PLANNING_BATCH_SIZE = 40;

interface JobsDocumentV4 { schemaVersion: 4; jobs: AiJob[] }

export class AiJobRepository {
  private readonly path: string;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async load(): Promise<AiJob[]> {
    const parsed = JSON.parse(await readFile(this.path, "utf8")) as {
      schemaVersion?: unknown;
      jobs?: unknown;
    };
    if (!Array.isArray(parsed.jobs) || ![1, 2, 3, 4].includes(parsed.schemaVersion as number)) {
      throw new Error("invalid jobs document");
    }
    return parsed.jobs.map((raw) => parsed.schemaVersion === 1 ? migrateV1Job(raw) : validateStoredV2Job(raw));
  }

  save(jobs: Iterable<AiJob>): Promise<void> {
    const document: JobsDocumentV4 = {
      schemaVersion: 4,
      jobs: [...jobs].map((job) => structuredClone(job)),
    };
    const operation = () => atomicWrite(this.path, `${JSON.stringify(document, null, 2)}\n`);
    const result = this.persistQueue.then(operation, operation);
    this.persistQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function publicJob(job: AiJob): AiJob {
  const copy = structuredClone(job);
  delete copy.failedItemIds;
  delete copy.topicCheckpoints;
  delete copy.analysisSnapshot;
  delete copy.analysisCatalog;
  copy.responseLogs = [];
  return copy;
}

export function jobSummary(job: AiJob): AiJobSummary {
  const summary: AiJobSummary = {
    id: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
    scope: structuredClone(job.scope), fields: [...job.fields], groupStrategy: job.groupStrategy, destinationScope: job.destinationScope ?? "selected", missingOnly: job.missingOnly === true,
    groupingOptions: structuredClone(job.groupingOptions),
    phase: job.phase, progress: structuredClone(job.progress), failureCount: job.failures.length,
    suggestionCount: job.decisionStats.changed, keptCount: job.decisionStats.kept,
    proposedGroupCount: job.proposedGroups.filter(({ itemCount }) => itemCount > 0).length,
  };
  if (job.planningProgress) summary.planningProgress = structuredClone(job.planningProgress);
  const model = job.responseLogs.findLast(({ model }) => Boolean(model))?.model;
  if (model) summary.model = model;
  if (job.appliedAt) summary.appliedAt = job.appliedAt;
  if (job.appliedCount !== undefined) summary.appliedCount = job.appliedCount;
  if (job.lifecycleStatus) summary.lifecycleStatus = job.lifecycleStatus;
  return summary;
}

export function prepareStoredJobForResume(job: AiJob, now: number): void {
  job.status = "queued";
  job.lifecycleStatus = "queued";
  job.updatedAt = new Date(now).toISOString();
  if (job.phase === "group_planning" && !job.groupPlan) {
    const completed = (job.topicCheckpoints ?? []).reduce((total, checkpoint) => total + checkpoint.itemIds.length, 0);
    job.planningProgress = { total: job.progress.total, completed, failed: 0, batchSize: GROUP_PLANNING_BATCH_SIZE };
  }
  for (const checkpoint of job.batchCheckpoints ?? []) {
    if (checkpoint.status === "running") checkpoint.status = "pending";
  }
}

function validateStoredV2Job(raw: unknown): AiJob {
  const value = raw as AiJob;
  const fields = new Set<AiField>(["title", "groupId", "description", "tags"]);
  const statuses = new Set(["queued", "running", "paused", "completed", "partial", "failed", "cancelled"]);
  if (!raw || typeof raw !== "object" || typeof value.id !== "string" || !statuses.has(value.status) ||
      !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt)) ||
      typeof value.catalogVersion !== "string" || !/^[a-f\d]{64}$/i.test(value.catalogVersion) ||
      !["existing", "reorganize", "rebuild"].includes(value.groupStrategy) || !Array.isArray(value.fields) ||
      !value.fields.every((field) => fields.has(field)) || !value.progress || !value.scope ||
      !["all", "groups", "items"].includes(value.scope.type) || !Array.isArray(value.failures) ||
      !Array.isArray(value.suggestions) || !Array.isArray(value.proposedGroups) ||
      !Array.isArray(value.responseLogs) || !value.decisionStats) {
    throw new Error("invalid stored AI job");
  }
  const copy = structuredClone(value);
  copy.groupingOptions ??= resolvedGroupingOptions(undefined, copy.progress.total, copy.groupStrategy);
  return copy;
}

function migrateV1Job(raw: unknown): AiJob {
  const value = raw as Partial<AiJob> & { expiresAt?: string };
  if (!raw || typeof raw !== "object" || typeof value.id !== "string" || !Array.isArray(value.fields) ||
      !Array.isArray(value.suggestions) || !Array.isArray(value.failures) || !value.progress || !value.scope ||
      typeof value.catalogVersion !== "string" || typeof value.status !== "string" ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new Error("invalid legacy AI job");
  }
  const suggestions = value.suggestions.map((suggestion) => ({ ...structuredClone(suggestion),
    status: suggestion.status === "kept" ? "kept" : suggestion.status,
  })) as AiSuggestion[];
  const job: AiJob = {
    id: value.id, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt,
    scope: structuredClone(value.scope), fields: [...value.fields],
    allowNewGroups: value.allowNewGroups === true,
    groupStrategy: value.allowNewGroups ? "reorganize" : "existing",
    groupingOptions: resolvedGroupingOptions(undefined, value.progress.total, value.allowNewGroups ? "reorganize" : "existing"),
    phase: ["queued", "running"].includes(value.status) ? "queued" : "review",
    catalogVersion: value.catalogVersion, progress: structuredClone(value.progress),
    failures: structuredClone(value.failures), suggestions, proposedGroups: [],
    decisionStats: { total: suggestions.length, changed: suggestions.length, kept: 0 }, responseLogs: [],
  };
  if (Array.isArray(value.failedItemIds)) job.failedItemIds = [...value.failedItemIds];
  return job;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
