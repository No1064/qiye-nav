import { HttpError } from "./errors.js";
import type { AiJob } from "./types.js";

export function queueJob(job: AiJob, now: number): void {
  job.status = "queued";
  job.lifecycleStatus = "queued";
  job.updatedAt = new Date(now).toISOString();
}

export function startJob(job: AiJob, now: number): void {
  job.status = "running";
  job.lifecycleStatus = "running";
  job.updatedAt = new Date(now).toISOString();
}

export function pauseJob(job: AiJob, now: number): void {
  if (!["queued", "running"].includes(job.status)) {
    throw new HttpError(409, "Only queued or running AI jobs can be paused", "ai_job_not_pausable");
  }
  job.status = "paused";
  job.lifecycleStatus = "paused";
  job.pausedAt = new Date(now).toISOString();
  job.updatedAt = job.pausedAt;
}

export function resumeJob(job: AiJob, now: number): void {
  if (job.status !== "paused") {
    throw new HttpError(409, "Only paused AI jobs can be resumed", "ai_job_not_resumable");
  }
  queueJob(job, now);
  job.phase = job.groupPlan || job.groupStrategy === "existing" ? "item_analysis" : "group_planning";
  delete job.pausedAt;
}

export function cancelJob(job: AiJob, now: number): void {
  job.status = "cancelled";
  job.lifecycleStatus = "cancelled";
  job.phase = "review";
  job.updatedAt = new Date(now).toISOString();
}

export function finishAnalysis(job: AiJob, now: number): void {
  job.status = job.progress.failed === 0
    ? "completed" : job.progress.succeeded === 0 ? "failed" : "partial";
  job.lifecycleStatus = "awaiting_review";
  job.phase = "review";
  job.updatedAt = new Date(now).toISOString();
}
