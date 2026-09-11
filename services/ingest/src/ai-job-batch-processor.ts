import { createHash } from "node:crypto";
import type { WorkItem } from "./ai-job-model.js";
import { HttpError } from "./errors.js";
import type { AiJob, AiResponseLog } from "./types.js";

const BATCH_SIZE = 20;
export const ITEM_ANALYSIS_TIMEOUT_MS = 90_000;

export function nextBatchNumber(job: AiJob): number {
  return Math.max(0, ...(job.batchCheckpoints ?? [])
    .filter(({ phase }) => phase === "item_analysis")
    .map(({ batch }) => batch)) + 1;
}

export function adaptiveBatchSize(job: AiJob): number {
  const successful = (job.batchCheckpoints ?? [])
    .filter(({ phase, status, durationMs }) => phase === "item_analysis" && status === "succeeded" && durationMs !== undefined)
    .slice(-3);
  if (!successful.length) return job.recommendedBatchSize ?? BATCH_SIZE;
  const perItemMs = successful.reduce((total, row) => total + row.durationMs! / row.itemIds.length, 0) / successful.length;
  return Math.max(5, Math.min(40, Math.floor((ITEM_ANALYSIS_TIMEOUT_MS * 0.6) / Math.max(1, perItemMs))));
}

export function beginBatchCheckpoint(
  job: AiJob, batch: WorkItem[], batchNumber: number, splitPart: number | undefined, now: number,
): NonNullable<AiJob["batchCheckpoints"]>[number] {
  const itemIds = batch.map(({ item }) => item.id);
  const id = `${batchNumber}${splitPart ? `.${splitPart}` : ""}`;
  job.batchCheckpoints ??= [];
  const existing = job.batchCheckpoints.find((entry) => entry.id === id);
  const checkpoint = existing ?? {
    id, phase: "item_analysis" as const, batch: batchNumber, itemIds,
    inputDigest: createHash("sha256").update(JSON.stringify(batch)).digest("hex"),
    status: "pending" as const, batchSize: batch.length, attempts: 0,
  };
  if (!existing) job.batchCheckpoints.push(checkpoint);
  checkpoint.status = "running";
  checkpoint.attempts += 1;
  checkpoint.startedAt = new Date(now).toISOString();
  delete checkpoint.endedAt;
  delete checkpoint.durationMs;
  delete checkpoint.error;
  return checkpoint;
}

export function finishBatchCheckpoint(
  checkpoint: NonNullable<AiJob["batchCheckpoints"]>[number],
  status: "succeeded" | "failed",
  now: number,
  error?: unknown,
): void {
  checkpoint.status = status;
  checkpoint.endedAt = new Date(now).toISOString();
  checkpoint.durationMs = Math.max(0, now - Date.parse(checkpoint.startedAt ?? checkpoint.endedAt));
  if (error) checkpoint.error = {
    code: error instanceof HttpError ? error.code : "ai_job_failed",
    message: error instanceof Error ? error.message : "AI batch failed",
  };
}

export function upstreamStatus(error: HttpError): number | undefined {
  const value = (error.details as { upstreamStatus?: unknown } | undefined)?.upstreamStatus;
  return typeof value === "number" ? value : undefined;
}

export function providerRequestId(error: HttpError): string | undefined {
  const value = (error.details as { providerRequestId?: unknown } | undefined)?.providerRequestId;
  return typeof value === "string" ? value : undefined;
}

export function failureCategory(error: unknown): AiResponseLog["errorCategory"] {
  if (!(error instanceof HttpError)) return "unknown";
  if (error.code === "ai_timeout" || error.code === "ai_request_failed") return "network_timeout";
  if (error.code === "ai_rate_limited") return "rate_limit";
  if (error.code === "ai_content_filtered") return "content_filter";
  if (error.code === "ai_invalid_response") return /omitted|missing/i.test(error.message) ? "missing_items" : "invalid_json";
  if (error.code.includes("stale") || error.code.includes("conflict")) return "catalog_conflict";
  if (error.code === "ai_job_interrupted") return "service_restart";
  if (error.code.startsWith("ai_")) return "provider_error";
  return "unknown";
}

export function suggestedAction(error: unknown): string {
  const category = failureCategory(error);
  if (category === "rate_limit") return "Wait for the provider limit window, then retry this batch.";
  if (category === "network_timeout") return "Retry this batch; completed checkpoints will not be rerun.";
  if (category === "invalid_json" || category === "missing_items") return "Retry the failed batch or adjust the model configuration.";
  if (category === "catalog_conflict") return "Review the current catalog value and resolve the conflict explicitly.";
  return "Inspect the response log and retry only the failed batch.";
}
