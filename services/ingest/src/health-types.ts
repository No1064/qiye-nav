import type { DashyCatalog } from "./types.js";
import type { HealthChangeSetResult } from "./health-governance.js";

export type HealthJobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type HealthJobScope = { type: "all" } | { type: "groups"; ids: string[] };
export type HealthRemoteCategory =
  | "ok"
  | "permanent_redirect"
  | "temporary_redirect"
  | "auth_required"
  | "not_found"
  | "timeout"
  | "dns_error"
  | "other_error";
export type HealthFindingKind =
  | "exact_duplicate"
  | "suspected_duplicate"
  | "duplicate_title"
  | "missing_metadata"
  | "empty_group";

export interface HealthItemRef {
  groupId: string;
  groupName: string;
  itemId: string;
  title: string;
  url: string;
  localUrl?: string;
  description?: string;
  icon?: string;
  tags?: string[];
}

export interface HealthFinding {
  id: string;
  kind: HealthFindingKind;
  message: string;
  items: HealthItemRef[];
  groupId?: string;
}

export interface HealthRemoteResult {
  item: HealthItemRef;
  category: HealthRemoteCategory;
  checkedAt: string;
  durationMs: number;
  status?: number;
  location?: string;
  error?: string;
}

export interface HealthJob {
  id: string;
  status: HealthJobStatus;
  createdAt: string;
  updatedAt: string;
  catalogVersion: string;
  includeRemote: boolean;
  scope: HealthJobScope;
  progress: { total: number; processed: number; skipped: number; failed: number };
  findings: HealthFinding[];
  remoteResults: HealthRemoteResult[];
  changeSets?: HealthChangeSetResult[];
  /** Internal per-item checkpoint, including targets deliberately skipped by SSRF policy. */
  checkpointItemKeys?: string[];
  snapshot: DashyCatalog;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  pausedAt?: string;
}

export interface HealthJobSummary {
  id: string;
  status: HealthJobStatus;
  createdAt: string;
  updatedAt: string;
  catalogVersion: string;
  includeRemote: boolean;
  scope: HealthJobScope;
  progress: HealthJob["progress"];
  findingCount: number;
  completedAt?: string;
  error?: string;
}

export type HealthJobPublic = Omit<HealthJob, "snapshot" | "checkpointItemKeys">;
