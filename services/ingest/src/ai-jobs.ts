import { randomUUID } from "node:crypto";
import { AiClient, isRetryableAiError, type AiCompletion } from "./ai-client.js";
import { AiConfigStore } from "./ai-config.js";
import {
  markApplied as recordApplied,
  retireGroupsToApply as selectRetireGroups,
  suggestionsToApply as selectSuggestions,
} from "./ai-job-application.js";
import {
  adaptiveBatchSize,
  beginBatchCheckpoint,
  failureCategory,
  finishBatchCheckpoint,
  ITEM_ANALYSIS_TIMEOUT_MS,
  nextBatchNumber,
  providerRequestId,
  suggestedAction,
  upstreamStatus,
} from "./ai-job-batch-processor.js";
import type { CreateAiJobInput } from "./ai-job-input.js";
export {
  parseCreateAiJob,
  parseRetireGroupIds,
  parseSuggestionIds,
  type CreateAiJobInput,
} from "./ai-job-input.js";
import {
  AiJobRepository,
  GROUP_PLANNING_BATCH_SIZE,
  jobSummary,
  prepareStoredJobForResume,
  publicJob,
} from "./ai-job-repository.js";
import {
  normalizedName,
  resolvedGroupingOptions,
  selectItems,
  type TopicCandidate,
  type WorkItem,
} from "./ai-job-model.js";
import {
  promptForGroupConsolidation,
  promptForItems,
  promptForMissingTopics,
  promptForTopicExtraction,
} from "./ai-job-prompts.js";
import {
  invalidResponse,
  parseDecisions,
  parseGroupPlan,
  parseTopicCandidatesPartial,
} from "./ai-job-response-parser.js";
import {
  cancelJob,
  finishAnalysis,
  pauseJob,
  resumeJob,
  startJob,
} from "./ai-job-state-machine.js";
import { HttpError } from "./errors.js";
import type {
  AiConfigRecord,
  AiGroupPlan,
  AiApplyResult,
  AiJob,
  AiJobSummary,
  AiResponseLog,
  AiSuggestion,
  CatalogRepository,
  DashyCatalog,
} from "./types.js";

const MAX_TOPIC_RECOVERY_ROUNDS = 3;
const GROUP_PLANNING_TIMEOUT_MS = 60_000;
const GROUP_CONSOLIDATION_TIMEOUT_MS = 180_000;
const MAX_LOG_CONTENT_BYTES = 128 * 1024;
const MAX_JOB_LOG_BYTES = 5 * 1024 * 1024;
const RAW_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

function phaseTimeoutMs(phase: AiResponseLog["phase"]): number {
  if (phase === "group_planning") return GROUP_PLANNING_TIMEOUT_MS;
  if (phase === "group_consolidation") return GROUP_CONSOLIDATION_TIMEOUT_MS;
  return ITEM_ANALYSIS_TIMEOUT_MS;
}

export interface AiJobsOptions {
  path: string;
  store: CatalogRepository;
  configStore: AiConfigStore;
  client?: AiClient;
  retryDelaysMs?: number[];
  now?: () => number;
  phaseTimeoutMs?: Partial<Record<AiResponseLog["phase"], number>>;
  minRequestIntervalMs?: number;
}

export class AiJobs {
  private readonly repository: AiJobRepository;
  private readonly client: AiClient;
  private readonly retryDelaysMs: number[];
  private readonly now: () => number;
  private jobs = new Map<string, AiJob>();
  private queue: string[] = [];
  private worker: Promise<void> | undefined;
  private lastRequestStartedAt = 0;

  constructor(private readonly options: AiJobsOptions) {
    this.repository = new AiJobRepository(options.path);
    this.client = options.client ?? new AiClient();
    this.retryDelaysMs = options.retryDelaysMs ?? [500, 2_000];
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    try {
      for (const job of await this.repository.load()) {
        if (job.status === "running" || job.status === "queued") {
          prepareStoredJobForResume(job, this.now());
          this.queue.push(job.id);
        }
        this.jobs.set(job.id, job);
      }
      this.purgeOldLogContent();
      await this.persist();
      this.startWorker();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.persist();
        return;
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, "AI jobs file is corrupt", "ai_jobs_corrupt");
    }
  }

  async list(limit = 20, offset = 0): Promise<{ jobs: AiJobSummary[]; nextOffset?: number }> {
    if (this.purgeOldLogContent()) await this.persist();
    const sorted = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const jobs = sorted.slice(offset, offset + limit).map(jobSummary);
    const result: { jobs: AiJobSummary[]; nextOffset?: number } = { jobs };
    if (offset + jobs.length < sorted.length) result.nextOffset = offset + jobs.length;
    return result;
  }

  async get(id: string): Promise<AiJob> {
    return publicJob(this.requireJob(id));
  }

  async logs(id: string, after = 0): Promise<{ logs: AiResponseLog[]; nextSequence: number }> {
    const job = this.requireJob(id);
    const logs = job.responseLogs.filter((entry) => entry.sequence > after).map((entry) => structuredClone(entry));
    return { logs, nextSequence: job.responseLogs.at(-1)?.sequence ?? after };
  }

  async create(input: CreateAiJobInput): Promise<AiJob> {
    const catalog = await this.options.store.getCatalog();
    const items = selectItems(catalog, input.scope);
    const createdAt = new Date(this.now()).toISOString();
    const groupStrategy = input.groupStrategy ?? (input.allowNewGroups ? "reorganize" : "existing");
    const groupingOptions = resolvedGroupingOptions(input.groupingOptions, items.length, groupStrategy);
    const job: AiJob = {
      id: randomUUID(), status: "queued", createdAt, updatedAt: createdAt,
      scope: structuredClone(input.scope), fields: [...input.fields],
      allowNewGroups: groupStrategy !== "existing", groupStrategy, groupingOptions,
      destinationScope: input.destinationScope ?? "selected",
      missingOnly: input.missingOnly === true,
      phase: "queued", catalogVersion: catalog.version,
      lifecycleStatus: "queued",
      analysisSnapshot: structuredClone(items),
      analysisCatalog: structuredClone(catalog),
      progress: { total: items.length, processed: 0, succeeded: 0, failed: 0 },
      ...(groupStrategy === "existing" ? {} : { planningProgress: {
        total: items.length, completed: 0, failed: 0, batchSize: GROUP_PLANNING_BATCH_SIZE,
      } }),
      failures: [], suggestions: [], proposedGroups: [],
      decisionStats: { total: 0, changed: 0, kept: 0 }, responseLogs: [],
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    await this.persist();
    this.startWorker();
    return publicJob(job);
  }

  async retry(id: string): Promise<AiJob> {
    const job = this.requireJob(id);
    if (job.status !== "failed" && job.status !== "partial") {
      throw new HttpError(409, "Only failed or partial AI jobs can be retried", "ai_job_not_retryable");
    }
    const catalog = await this.options.store.getCatalog();
    if (catalog.version !== job.catalogVersion) {
      throw new HttpError(409, "Catalog changed; create a new AI job", "ai_job_stale", {
        jobVersion: job.catalogVersion, currentVersion: catalog.version,
      });
    }
    const retryCount = job.failedItemIds?.length ?? job.progress.failed;
    job.status = "queued";
    job.lifecycleStatus = "queued";
    job.phase = "queued";
    job.updatedAt = new Date(this.now()).toISOString();
    job.failures = [];
    job.progress.failed = 0;
    job.progress.processed = Math.max(0, job.progress.total - retryCount);
    if (!job.groupPlan && job.groupStrategy !== "existing") {
      const completed = (job.topicCheckpoints ?? []).reduce((total, checkpoint) => total + checkpoint.itemIds.length, 0);
      job.planningProgress = {
        total: job.progress.total, completed, failed: 0, batchSize: GROUP_PLANNING_BATCH_SIZE,
      };
      job.progress.processed = 0;
    }
    this.queue.push(job.id);
    await this.persist();
    this.startWorker();
    return publicJob(job);
  }

  async delete(id: string): Promise<void> {
    const job = this.requireJob(id);
    if (job.lifecycleStatus === "applied" || job.lifecycleStatus === "partially_applied" || job.appliedCount) {
      throw new HttpError(409, "Applied AI jobs are immutable audit records", "ai_job_immutable");
    }
    if (job.status === "queued" || job.status === "running") {
      cancelJob(job, this.now());
    } else {
      this.jobs.delete(id);
      this.queue = this.queue.filter((queued) => queued !== id);
    }
    await this.persist();
  }

  async pause(id: string): Promise<AiJob> {
    const job = this.requireJob(id);
    pauseJob(job, this.now());
    this.queue = this.queue.filter((queued) => queued !== id);
    await this.persist();
    return publicJob(job);
  }

  async resume(id: string): Promise<AiJob> {
    const job = this.requireJob(id);
    resumeJob(job, this.now());
    this.queue.push(id);
    await this.persist();
    this.startWorker();
    return publicJob(job);
  }

  suggestionsToApply(id: string, ids?: string[]): AiSuggestion[] {
    return selectSuggestions(this.requireJob(id), ids);
  }

  catalogVersion(id: string): string {
    return this.requireJob(id).catalogVersion;
  }

  retireGroupsToApply(id: string, requested?: string[]): string[] {
    return selectRetireGroups(this.requireJob(id), requested);
  }

  async markApplied(id: string, ids: readonly string[], result?: AiApplyResult): Promise<void> {
    const job = this.requireJob(id);
    recordApplied(job, ids, this.now(), result);
    await this.persist();
  }

  private requireJob(id: string): AiJob {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, `AI job '${id}' does not exist`, "ai_job_not_found");
    return job;
  }

  private startWorker(): void {
    if (this.worker) return;
    this.worker = this.runQueue().finally(() => {
      this.worker = undefined;
      if (this.queue.length > 0) this.startWorker();
    });
  }

  private async runQueue(): Promise<void> {
    for (;;) {
      const id = this.queue.shift();
      if (!id) return;
      const job = this.jobs.get(id);
      if (!job || job.status !== "queued") continue;
      await this.process(job);
    }
  }

  private async process(job: AiJob): Promise<void> {
    startJob(job, this.now());
    await this.persist();
    let catalog: DashyCatalog;
    let config: AiConfigRecord;
    try {
      catalog = await this.options.store.getCatalog();
      if (!job.analysisSnapshot && catalog.version !== job.catalogVersion) {
        throw new HttpError(409, "Catalog changed; create a new AI job", "ai_job_stale", {
          jobVersion: job.catalogVersion, currentVersion: catalog.version,
        });
      }
      config = await this.options.configStore.requireConfig();
    } catch (error) {
      failWholeJob(job, error, this.now());
      await this.persist();
      return;
    }
    const analysisCatalog = job.analysisCatalog ?? catalog;
    let items = job.analysisSnapshot ? structuredClone(job.analysisSnapshot) : selectItems(catalog, job.scope);
    if (job.failedItemIds?.length) {
      const retryIds = new Set(job.failedItemIds);
      items = items.filter(({ item }) => retryIds.has(item.id));
      job.failedItemIds = [];
    } else if (job.batchCheckpoints?.length) {
      const completed = new Set(job.batchCheckpoints
        .filter(({ phase, status }) => phase === "item_analysis" && status === "succeeded")
        .flatMap(({ itemIds }) => itemIds));
      items = items.filter(({ item }) => !completed.has(item.id));
    }
    try {
      if (job.groupStrategy !== "existing" && job.fields.includes("groupId") && !job.groupPlan) {
        job.phase = "group_planning";
        await this.persist();
        job.groupPlan = await this.planGroups(config, analysisCatalog, job, structuredClone(job.analysisSnapshot ?? selectItems(analysisCatalog, job.scope)));
        job.proposedGroups = job.groupPlan.groups
          .filter((group) => !group.existingGroupId)
          .map((group) => ({
            id: group.id, name: group.name, description: group.description,
            reason: group.reason, confidence: group.confidence, itemCount: 0,
          }));
        await this.persist();
      }
    } catch (error) {
      job.failedItemIds = items.map(({ item }) => item.id);
      failPlanningJob(job, error, this.now());
      await this.persist();
      return;
    }
    job.phase = "item_analysis";
    await this.persist();
    let offset = 0;
    let batchNumber = nextBatchNumber(job);
    while (offset < items.length) {
      if (["cancelled", "paused"].includes(this.jobs.get(job.id)?.status ?? "")) break;
      const batchSize = adaptiveBatchSize(job);
      const batch = items.slice(offset, offset + batchSize);
      await this.analyzeItemBatch(job, config, analysisCatalog, batch, batchNumber);
      offset += batch.length;
      batchNumber += 1;
    }
    if (!["cancelled", "paused"].includes(this.jobs.get(job.id)?.status ?? "")) {
      finishAnalysis(job, this.now());
      await this.persist();
    }
  }

  private async analyzeItemBatch(
    job: AiJob,
    config: AiConfigRecord,
    catalog: DashyCatalog,
    batch: WorkItem[],
    batchNumber: number,
    splitPart?: number,
  ): Promise<void> {
    if (this.jobs.get(job.id)?.status === "cancelled") return;
    const checkpoint = beginBatchCheckpoint(job, batch, batchNumber, splitPart, this.now());
    await this.persist();
    try {
      const suggestions = await this.runLoggedRequest(
        job, config, "item_analysis", batchNumber, batch.length,
        promptForItems(catalog, job, batch),
        (content) => parseDecisions(content, catalog, job, batch),
        splitPart,
      );
      job.suggestions.push(...suggestions);
      recomputeDecisionStats(job);
      updateProposedGroupCounts(job);
      job.progress.processed += batch.length;
      job.progress.succeeded += batch.length;
      finishBatchCheckpoint(checkpoint, "succeeded", this.now());
      job.recommendedBatchSize = adaptiveBatchSize(job);
      job.updatedAt = new Date(this.now()).toISOString();
      await this.persist();
    } catch (error) {
      if (error instanceof HttpError && error.code === "ai_timeout" && batch.length > 10) {
        const midpoint = Math.ceil(batch.length / 2);
        await this.analyzeItemBatch(job, config, catalog, batch.slice(0, midpoint), batchNumber, 1);
        await this.analyzeItemBatch(job, config, catalog, batch.slice(midpoint), batchNumber, 2);
        return;
      }
      const known = error instanceof HttpError;
      const latestLog = job.responseLogs.at(-1);
      job.failures.push(withoutUndefined({
        batch: batchNumber,
        phase: "item_analysis",
        itemIds: batch.map(({ item }) => item.id),
        startedAt: checkpoint.startedAt,
        endedAt: checkpoint.endedAt,
        durationMs: checkpoint.durationMs,
        httpStatus: known ? upstreamStatus(error) : undefined,
        providerRequestId: known ? providerRequestId(error) : undefined,
        category: failureCategory(error),
        suggestedAction: suggestedAction(error),
        error: {
          code: known ? error.code : "ai_job_failed",
          message: known ? error.message : "AI batch failed",
        },
        ...(latestLog?.httpStatus ? { httpStatus: latestLog.httpStatus } : {}),
      }) as AiJob["failures"][number]);
      job.failedItemIds = [...(job.failedItemIds ?? []), ...batch.map(({ item }) => item.id)];
      job.progress.processed += batch.length;
      job.progress.failed += batch.length;
      finishBatchCheckpoint(checkpoint, "failed", this.now(), error);
      job.updatedAt = new Date(this.now()).toISOString();
      await this.persist();
    }
  }

  private async planGroups(
    config: AiConfigRecord, catalog: DashyCatalog, job: AiJob, items: WorkItem[],
  ): Promise<AiGroupPlan> {
    const candidates: TopicCandidate[] = [];
    const checkpoints = new Map((job.topicCheckpoints ?? []).map((entry) => [entry.batch, entry]));
    job.topicCheckpoints ??= [];
    job.planningProgress = {
      total: items.length,
      completed: 0,
      failed: 0,
      batchSize: GROUP_PLANNING_BATCH_SIZE,
    };
    for (let offset = 0; offset < items.length; offset += GROUP_PLANNING_BATCH_SIZE) {
      if (this.jobs.get(job.id)?.status === "cancelled") {
        return { summary: "任务已取消", targetGroupCount: 0, groups: [], retireGroupIds: [] };
      }
      const batch = items.slice(offset, offset + GROUP_PLANNING_BATCH_SIZE);
      const batchNumber = Math.floor(offset / GROUP_PLANNING_BATCH_SIZE) + 1;
      const itemIds = batch.map(({ item }) => item.id);
      const checkpoint = checkpoints.get(batchNumber);
      if (checkpoint && checkpoint.itemIds.length === itemIds.length &&
          checkpoint.itemIds.every((id, index) => id === itemIds[index])) {
        candidates.push(...structuredClone(checkpoint.candidates));
        job.planningProgress.completed += batch.length;
        continue;
      }
      let result: TopicCandidate[];
      try {
        result = await this.extractTopicBatch(config, catalog, job, batch, batchNumber);
      } catch (error) {
        if (job.planningProgress) job.planningProgress.failed = batch.length;
        throw new HttpError(
          error instanceof HttpError ? error.status : 502,
          `Topic planning batch ${batchNumber} failed: ${error instanceof Error ? error.message : "AI response invalid"}`,
          error instanceof HttpError ? error.code : "ai_job_failed",
          { phase: "group_planning", batch: batchNumber, itemCount: batch.length },
        );
      }
      candidates.push(...result);
      const saved = { batch: batchNumber, itemIds, candidates: structuredClone(result) };
      job.topicCheckpoints = job.topicCheckpoints.filter((entry) => entry.batch !== batchNumber);
      job.topicCheckpoints.push(saved);
      checkpoints.set(batchNumber, saved);
      if (job.planningProgress) {
        job.planningProgress.completed = Math.min(items.length, job.planningProgress.completed + batch.length);
        job.planningProgress.failed = 0;
      }
      await this.persist();
    }
    const plan = await this.runLoggedRequest(
      job, config, "group_consolidation", 1, items.length,
      promptForGroupConsolidation(catalog, job, candidates),
      (content) => parseGroupPlan(content, catalog, job, items),
    );
    delete job.topicCheckpoints;
    return plan;
  }

  private async extractTopicBatch(
    config: AiConfigRecord,
    _catalog: DashyCatalog,
    job: AiJob,
    batch: WorkItem[],
    batchNumber: number,
  ): Promise<TopicCandidate[]> {
    const remaining = new Map(batch.map((entry) => [entry.item.id, entry]));
    const candidates: TopicCandidate[] = [];
    for (let round = 0; remaining.size > 0 && round <= MAX_TOPIC_RECOVERY_ROUNDS; round += 1) {
      const pending = [...remaining.values()];
      const prompt = round === 0
        ? promptForTopicExtraction(pending, job.groupingOptions)
        : promptForMissingTopics(pending, job.groupingOptions, candidates, round);
      const partial = await this.runLoggedRequest(
        job, config, "group_planning", batchNumber, pending.length, prompt,
        (content) => parseTopicCandidatesPartial(content, pending),
      );
      for (const candidate of partial.candidates) {
        const freshIds = candidate.itemIds.filter((id) => remaining.has(id));
        if (!freshIds.length) continue;
        candidates.push({ ...candidate, itemIds: freshIds,
          sampleTitles: freshIds.slice(0, 5).map((id) => remaining.get(id)!.item.title),
        });
        for (const id of freshIds) remaining.delete(id);
      }
      if (partial.acceptedCount === 0 && remaining.size > 0) {
        throw invalidResponse(`AI topic recovery made no progress; ${remaining.size} items remain`);
      }
    }
    if (remaining.size > 0) {
      throw invalidResponse(`AI topic extraction still omitted ${remaining.size} items after targeted recovery`);
    }
    return candidates;
  }

  private async runLoggedRequest<T>(
    job: AiJob,
    config: AiConfigRecord,
    phase: AiResponseLog["phase"],
    batch: number,
    itemCount: number,
    prompt: string,
    parse: (content: string) => T,
    splitPart?: number,
  ): Promise<T> {
    let retryPrompt = prompt;
    const timeoutMs = this.options.phaseTimeoutMs?.[phase] ?? phaseTimeoutMs(phase);
    for (let attempt = 1;; attempt += 1) {
      let completion: AiCompletion | undefined;
      const started = this.now();
      try {
        await this.waitForRequestSlot();
        completion = await this.client.completeDetailed(
          config,
          retryPrompt,
          8_192,
          timeoutMs,
        );
        const result = parse(completion.content);
        this.appendLog(job, withoutUndefined({
          phase, batch, attempt, itemCount, splitPart, timeoutMs, provider: config.provider,
          model: completion.model, durationMs: completion.latencyMs,
          startedAt: new Date(started).toISOString(), endedAt: new Date(this.now()).toISOString(),
          status: "success", finishReason: completion.finishReason,
          usage: completion.usage, content: completion.content,
        }) as Omit<AiResponseLog, "sequence" | "at">);
        await this.persist();
        return result;
      } catch (error) {
        const known = error instanceof HttpError;
        this.appendLog(job, withoutUndefined({
          phase, batch, attempt, itemCount, splitPart, timeoutMs, provider: config.provider,
          model: completion?.model ?? config.model,
          durationMs: completion?.latencyMs ?? Math.max(0, this.now() - started),
          startedAt: new Date(started).toISOString(), endedAt: new Date(this.now()).toISOString(),
          httpStatus: known ? upstreamStatus(error) : undefined,
          providerRequestId: known ? providerRequestId(error) : undefined,
          errorCategory: failureCategory(error), suggestedAction: suggestedAction(error),
          status: "error", finishReason: completion?.finishReason,
          usage: completion?.usage, content: completion?.content,
          timeoutStage: known && error.code === "ai_timeout"
            ? (error.details as { stage?: "request" | "response_body" } | undefined)?.stage
            : undefined,
          error: { code: known ? error.code : "ai_job_failed", message: known ? error.message : "AI batch failed" },
        }) as Omit<AiResponseLog, "sequence" | "at">);
        await this.persist();
        const configuredDelay = this.retryDelaysMs[attempt - 1];
        const retryAfterMs = known && error.code === "ai_rate_limited"
          ? Number((error.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds) * 1_000
          : 0;
        const delay = configuredDelay === undefined
          ? undefined
          : configuredDelay === 0 ? 0
            : Math.min(30_000, Math.max(configuredDelay, Number.isFinite(retryAfterMs) ? retryAfterMs : 0));
        const retryable = isRetryableAiError(error) || (known && error.code === "ai_invalid_response");
        if (delay === undefined || !retryable) throw error;
        if (known && error.code === "ai_invalid_response") {
          retryPrompt = `${prompt}\n上一次响应未通过校验：${error.message}。请严格修正这一问题，不要重复上一版结构。`;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      }
    }
  }

  private appendLog(job: AiJob, input: Omit<AiResponseLog, "sequence" | "at">): void {
    const log: AiResponseLog = {
      sequence: (job.responseLogs.at(-1)?.sequence ?? 0) + 1,
      at: new Date(this.now()).toISOString(), ...withoutUndefined(input),
    } as AiResponseLog;
    if (log.content) {
      const existing = job.responseLogs.reduce((total, entry) => total + Buffer.byteLength(entry.content ?? "", "utf8"), 0);
      const available = Math.max(0, Math.min(MAX_LOG_CONTENT_BYTES, MAX_JOB_LOG_BYTES - existing));
      const truncated = truncateUtf8(log.content, available);
      log.content = truncated.value;
      if (truncated.truncated) log.truncated = true;
    }
    job.responseLogs.push(log);
    job.updatedAt = log.at;
  }

  private async waitForRequestSlot(): Promise<void> {
    const interval = Math.max(0, this.options.minRequestIntervalMs ?? 0);
    const delay = Math.max(0, this.lastRequestStartedAt + interval - this.now());
    if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    this.lastRequestStartedAt = this.now();
  }

  private purgeOldLogContent(): boolean {
    let changed = false;
    const cutoff = this.now() - RAW_LOG_RETENTION_MS;
    for (const job of this.jobs.values()) {
      let purged = false;
      for (const log of job.responseLogs) {
        if (log.content && Date.parse(log.at) < cutoff) {
          delete log.content;
          log.truncated = true;
          purged = true;
          changed = true;
        }
      }
      if (purged) job.logsPurgedAt = new Date(this.now()).toISOString();
    }
    return changed;
  }

  private persist(): Promise<void> {
    return this.repository.save(this.jobs.values());
  }
}

function recomputeDecisionStats(job: AiJob): void {
  job.decisionStats = {
    total: job.suggestions.length,
    changed: job.suggestions.filter(({ status }) => status !== "kept").length,
    kept: job.suggestions.filter(({ status }) => status === "kept").length,
  };
}

function updateProposedGroupCounts(job: AiJob): void {
  for (const proposal of job.proposedGroups) {
    proposal.itemCount = job.suggestions.filter(
      ({ field, createsGroup, suggestedValue }) => field === "groupId" && createsGroup &&
        typeof suggestedValue === "string" && normalizedName(suggestedValue) === normalizedName(proposal.name),
    ).length;
  }
  if (job.groupPlan) {
    for (const target of job.groupPlan.groups) {
      const rows = job.suggestions.filter(({ field, suggestedValue, createsGroup }) =>
        field === "groupId" && typeof suggestedValue === "string" &&
        (target.existingGroupId
          ? !createsGroup && suggestedValue === target.existingGroupId
          : createsGroup && normalizedName(suggestedValue) === normalizedName(target.name))
      );
      target.itemCount = rows.length;
      target.sourceGroupIds = [...new Set(rows.map(({ groupId }) => groupId))];
    }
  }
}

function failWholeJob(job: AiJob, error: unknown, now: number): void {
  const known = error instanceof HttpError;
  job.status = "failed";
  job.phase = "review";
  job.progress.failed = job.progress.total;
  job.progress.processed = job.progress.total;
  job.failures = [{ batch: 0, error: {
    code: known ? error.code : "ai_job_failed",
    message: known ? error.message : "AI job failed",
  } }];
  job.updatedAt = new Date(now).toISOString();
}

function failPlanningJob(job: AiJob, error: unknown, now: number): void {
  const known = error instanceof HttpError ? error : undefined;
  job.status = "failed";
  job.phase = "review";
  job.progress = { total: job.progress.total, processed: 0, succeeded: 0, failed: 0 };
  if (job.planningProgress) {
    job.planningProgress.failed = Number((known?.details as { itemCount?: unknown } | undefined)?.itemCount) || job.planningProgress.failed;
  }
  job.failures = [{
    batch: Number((known?.details as { batch?: unknown } | undefined)?.batch) || 0,
    error: { code: known?.code ?? "ai_job_failed", message: known?.message ?? "AI planning failed" },
  }];
  job.updatedAt = new Date(now).toISOString();
}

function truncateUtf8(value: string, maximum: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximum) return { value, truncated: false };
  if (maximum <= 0) return { value: "", truncated: true };
  return { value: bytes.subarray(0, maximum).toString("utf8"), truncated: true };
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
