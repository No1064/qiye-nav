import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import { HealthJobRepository } from "./health-job-repository.js";
import { catalogItems, checkRemoteUrl, scanCatalogLocally } from "./health-scan.js";
import type { HealthJob, HealthJobPublic, HealthJobSummary } from "./health-types.js";
import type { HealthJobScope } from "./health-types.js";
import type { HealthChangeSetResult } from "./health-governance.js";
import type { CatalogRepository } from "./types.js";
import type { LookupAddresses } from "./security.js";

export interface HealthJobsOptions {
  path: string;
  store: Pick<CatalogRepository, "getCatalog">;
  fetchImpl?: typeof fetch;
  lookup?: LookupAddresses;
  timeoutMs?: number;
  minRequestIntervalMs?: number;
  now?: () => number;
}

export class HealthJobs {
  private readonly repository: HealthJobRepository;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly minRequestIntervalMs: number;
  private jobs = new Map<string, HealthJob>();
  private queue: string[] = [];
  private worker: Promise<void> | undefined;
  private lastRequestAt = 0;

  constructor(private readonly options: HealthJobsOptions) {
    this.repository = new HealthJobRepository(options.path);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 250;
  }

  async initialize(): Promise<void> {
    try {
      for (const job of await this.repository.load()) {
        if (job.status === "running" || job.status === "queued") {
          job.status = "queued";
          job.updatedAt = this.isoNow();
          this.queue.push(job.id);
        }
        this.jobs.set(job.id, job);
      }
      await this.persist();
      this.startWorker();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { await this.persist(); return; }
      throw new HttpError(500, "Health jobs file is corrupt", "health_jobs_corrupt");
    }
  }

  async create(input: { includeRemote?: boolean; scope?: HealthJobScope } = {}): Promise<HealthJobPublic> {
    const catalog = await this.options.store.getCatalog();
    const scope: HealthJobScope = structuredClone(input.scope ?? { type: "all" });
    const snapshot = scopedSnapshot(catalog, scope);
    if (scope.type === "groups") scope.ids = [...new Set([...scope.ids, ...snapshot.groups.map((group) => group.id)])];
    const createdAt = this.isoNow();
    const job: HealthJob = {
      id: randomUUID(), status: "queued", createdAt, updatedAt: createdAt,
      catalogVersion: snapshot.version, includeRemote: input.includeRemote !== false,
      scope,
      snapshot, findings: scanCatalogLocally(snapshot), remoteResults: [], checkpointItemKeys: [],
      progress: { total: catalogItems(snapshot).length, processed: 0, skipped: 0, failed: 0 },
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    await this.persist();
    this.startWorker();
    return publicJob(job);
  }

  async list(limit = 20, offset = 0): Promise<{ jobs: HealthJobSummary[]; nextOffset?: number }> {
    const sorted = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const jobs = sorted.slice(offset, offset + limit).map(summary);
    return offset + jobs.length < sorted.length ? { jobs, nextOffset: offset + jobs.length } : { jobs };
  }

  /** 只读：返回最近一次完成的健康任务（含明细），无任务时返回 null。 */
  async latestCompleted(): Promise<HealthJob | null> {
    const completed = [...this.jobs.values()]
      .filter((job) => job.status === "completed")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return completed[0] ?? null;
  }

  async get(id: string): Promise<HealthJobPublic> { return publicJob(this.requireJob(id)); }

  async recordChangeSet(id: string, changeSet: HealthChangeSetResult): Promise<void> {
    const job = this.requireJob(id);
    job.changeSets ??= [];
    if (changeSet.changeSetId && !job.changeSets.some(({ changeSetId }) => changeSetId === changeSet.changeSetId)) {
      job.changeSets.push(structuredClone(changeSet));
      job.updatedAt = this.isoNow();
      await this.persist();
    }
  }

  async pause(id: string): Promise<HealthJobPublic> {
    const job = this.requireJob(id);
    if (job.status !== "queued" && job.status !== "running") {
      throw new HttpError(409, "Only queued or running health jobs can be paused", "health_job_not_pausable");
    }
    job.status = "paused";
    job.pausedAt = this.isoNow();
    job.updatedAt = job.pausedAt;
    this.queue = this.queue.filter((queued) => queued !== id);
    await this.persist();
    return publicJob(job);
  }

  async resume(id: string): Promise<HealthJobPublic> {
    const job = this.requireJob(id);
    if (job.status !== "paused") throw new HttpError(409, "Only paused health jobs can be resumed", "health_job_not_resumable");
    job.status = "queued";
    job.updatedAt = this.isoNow();
    delete job.pausedAt;
    this.queue.push(id);
    await this.persist();
    this.startWorker();
    return publicJob(job);
  }

  async cancel(id: string): Promise<HealthJobPublic> {
    const job = this.requireJob(id);
    if (!["queued", "running", "paused"].includes(job.status)) {
      throw new HttpError(409, "Finished health jobs cannot be cancelled", "health_job_not_cancellable");
    }
    job.status = "cancelled";
    job.updatedAt = this.isoNow();
    this.queue = this.queue.filter((queued) => queued !== id);
    await this.persist();
    return publicJob(job);
  }

  /** Useful for graceful shutdown and deterministic integration tests. */
  async waitForIdle(): Promise<void> { await this.worker; }

  private requireJob(id: string): HealthJob {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, `Health job '${id}' does not exist`, "health_job_not_found");
    return job;
  }

  private startWorker(): void {
    if (this.worker) return;
    this.worker = this.runQueue().finally(() => {
      this.worker = undefined;
      if (this.queue.length) this.startWorker();
    });
  }

  private async runQueue(): Promise<void> {
    while (this.queue.length) {
      const id = this.queue.shift() as string;
      const job = this.jobs.get(id);
      if (!job || job.status !== "queued") continue;
      await this.process(job);
    }
  }

  private async process(job: HealthJob): Promise<void> {
    job.status = "running";
    job.startedAt ??= this.isoNow();
    job.updatedAt = this.isoNow();
    await this.persist();
    try {
      if (!job.includeRemote) {
        job.status = "completed";
        job.progress.skipped = job.progress.total;
        job.completedAt = this.isoNow();
        job.updatedAt = job.completedAt;
        await this.persist();
        return;
      }
      const completed = new Set(job.checkpointItemKeys ?? job.remoteResults.map(({ item }) => itemKey(item.groupId, item.itemId)));
      for (const item of catalogItems(job.snapshot)) {
        const key = itemKey(item.groupId, item.itemId);
        if (completed.has(key)) continue;
        if (job.status !== "running") return;
        await this.rateLimit();
        const remote = await checkRemoteUrl(item, { fetchImpl: this.fetchImpl,
          ...(this.options.lookup ? { lookup: this.options.lookup } : {}), timeoutMs: this.timeoutMs, now: this.now });
        if (remote) {
          job.remoteResults.push(remote);
          job.progress.processed += 1;
          if (["timeout", "dns_error", "other_error"].includes(remote.category)) job.progress.failed += 1;
        } else {
          job.progress.skipped += 1;
        }
        (job.checkpointItemKeys ??= []).push(key);
        job.updatedAt = this.isoNow();
        await this.persist();
      }
      if (job.status !== "running") return;
      job.status = "completed";
      job.completedAt = this.isoNow();
      job.updatedAt = job.completedAt;
      await this.persist();
    } catch (error) {
      if (job.status !== "running") return;
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "Health scan failed";
      job.updatedAt = this.isoNow();
      await this.persist();
    }
  }

  private async rateLimit(): Promise<void> {
    const wait = Math.max(0, this.lastRequestAt + this.minRequestIntervalMs - this.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = this.now();
  }
  private isoNow(): string { return new Date(this.now()).toISOString(); }
  private persist(): Promise<void> { return this.repository.save(this.jobs.values()); }
}

function itemKey(groupId: string, itemId: string): string { return `${groupId}\u0000${itemId}`; }
function publicJob(job: HealthJob): HealthJobPublic {
  const copy = structuredClone(job) as Partial<HealthJob>;
  delete copy.snapshot;
  delete copy.checkpointItemKeys;
  return copy as HealthJobPublic;
}
function summary(job: HealthJob): HealthJobSummary {
  return { id: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
    catalogVersion: job.catalogVersion, includeRemote: job.includeRemote, scope: structuredClone(job.scope),
    progress: structuredClone(job.progress), findingCount: job.findings.length,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}), ...(job.error ? { error: job.error } : {}) };
}

function scopedSnapshot(catalog: Awaited<ReturnType<CatalogRepository["getCatalog"]>>, scope: HealthJobScope) {
  if (scope.type === "all") return structuredClone(catalog);
  const requested = new Set(scope.ids);
  const available = new Set(catalog.groups.map(({ id }) => id));
  const missing = scope.ids.filter((id) => !available.has(id));
  if (missing.length) {
    throw new HttpError(400, "scope.ids contains group ids that do not exist", "health_scope_group_not_found", { ids: missing });
  }
  for (const group of catalog.groups) if (group.parentId && requested.has(group.parentId)) requested.add(group.id);
  const snapshot = structuredClone(catalog);
  snapshot.groups = snapshot.groups.filter(({ id }) => requested.has(id));
  return snapshot;
}
