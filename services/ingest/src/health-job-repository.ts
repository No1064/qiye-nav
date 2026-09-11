import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { HealthJob, HealthJobScope, HealthJobStatus } from "./health-types.js";

interface HealthJobsDocumentV1 { schemaVersion: 1; jobs: HealthJob[] }
const STATUSES = new Set<HealthJobStatus>(["queued", "running", "paused", "completed", "failed", "cancelled"]);

export class HealthJobRepository {
  private readonly path: string;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(path: string) { this.path = resolve(path); }

  async load(): Promise<HealthJob[]> {
    const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<HealthJobsDocumentV1>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.jobs)) throw new Error("invalid health jobs document");
    return parsed.jobs.map(validateJob);
  }

  save(jobs: Iterable<HealthJob>): Promise<void> {
    const document: HealthJobsDocumentV1 = { schemaVersion: 1, jobs: [...jobs].map((job) => structuredClone(job)) };
    const operation = () => atomicWrite(this.path, `${JSON.stringify(document, null, 2)}\n`);
    const result = this.persistQueue.then(operation, operation);
    this.persistQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateJob(raw: unknown): HealthJob {
  const job = raw as HealthJob;
  if (!job || typeof job !== "object" || typeof job.id !== "string" || !STATUSES.has(job.status) ||
      typeof job.createdAt !== "string" || typeof job.updatedAt !== "string" ||
      !job.snapshot || !Array.isArray(job.snapshot.groups) || !job.progress ||
      !Array.isArray(job.findings) || !Array.isArray(job.remoteResults)) {
    throw new Error("invalid stored health job");
  }
  const copy = structuredClone(job);
  copy.includeRemote ??= true;
  copy.scope = validateScope(copy.scope);
  if (copy.scope.type === "groups") {
    const scopedIds = new Set(copy.scope.ids);
    const snapshotIds = copy.snapshot.groups.map(({ id }) => id);
    if (new Set(snapshotIds).size !== snapshotIds.length || snapshotIds.length !== scopedIds.size ||
        snapshotIds.some((id) => !scopedIds.has(id))) {
      throw new Error("health job snapshot does not match its scope");
    }
  }
  copy.checkpointItemKeys ??= copy.remoteResults.map(({ item }) => `${item.groupId}\u0000${item.itemId}`);
  return copy;
}

function validateScope(value: unknown): HealthJobScope {
  if (value === undefined) return { type: "all" };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid health job scope");
  const scope = value as Record<string, unknown>;
  if (scope.type === "all") {
    if (scope.ids !== undefined) throw new Error("invalid all health job scope");
    return { type: "all" };
  }
  if (scope.type !== "groups" || !Array.isArray(scope.ids) || scope.ids.length < 1 || scope.ids.length > 100) {
    throw new Error("invalid groups health job scope");
  }
  if (scope.ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 200) ||
      new Set(scope.ids).size !== scope.ids.length) {
    throw new Error("invalid health job group ids");
  }
  return { type: "groups", ids: [...scope.ids] as string[] };
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
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
