export interface AppConfig {
  port: number;
  ingestToken: string;
  corsAllowedOrigins: ReadonlySet<string>;
  allowLocalUrls: boolean;
  defaultGroup: string;
  fetchTimeoutMs: number;
  fetchMaxBytes: number;
  idempotencyTtlMs: number;
  catalogPath: string;
  catalogBackupDir: string;
  catalogInitPath?: string;
  adminUsername: string;
  adminPasswordHash: string;
  adminCookieSecure: boolean;
  aiConfigPath: string;
  aiJobsPath: string;
  importSessionsPath: string;
  healthJobsPath: string;
  aiConfigEncryptionKey: Buffer;
}

export interface Metadata {
  title?: string;
  description?: string;
  favicon?: string;
  finalUrl: string;
}

export interface CatalogSettings {
  title: string;
  subtitle: string;
  defaultSearchEngine: string;
  localAccessHosts: string[];
}

export interface CatalogSettingsPatch {
  title?: string;
  subtitle?: string;
  defaultSearchEngine?: string;
  localAccessHosts?: string[];
}

export interface DashyGroup {
  id: string;
  name: string;
  icon?: string;
  parentId?: string;
  itemCount: number;
}

export interface DashyItem {
  title: string;
  url: string;
  description?: string;
  icon?: string;
  localUrl?: string;
  tags?: string[];
}

export interface CatalogItem extends DashyItem {
  id: string;
}

export interface CatalogGroup extends DashyGroup {
  items: CatalogItem[];
}

export interface DashyCatalog {
  schemaVersion: 1;
  version: string;
  settings: CatalogSettings;
  groups: CatalogGroup[];
}

export interface GroupInput {
  name: string;
  icon?: string;
  parentId?: string;
}

export interface GroupPatch {
  name?: string;
  icon?: string | null;
  parentId?: string | null;
}

export interface ItemPatch {
  title?: string;
  url?: string;
  localUrl?: string | null;
  description?: string | null;
  icon?: string | null;
  tags?: string[] | null;
}

export interface DuplicateItem {
  groupId: string;
  groupName: string;
  itemId: string;
  item: DashyItem;
}

export interface CatalogRepository {
  getCatalog(): Promise<DashyCatalog>;
  listGroups(): Promise<DashyGroup[]>;
  findDuplicate(normalizedUrls: ReadonlySet<string>): Promise<DuplicateItem | undefined>;
  addBookmark(groupId: string | undefined, item: DashyItem): Promise<{
    group: DashyGroup;
    result: unknown;
  }>;
  createGroup(input: GroupInput): Promise<void>;
  updateGroup(groupId: string, patch: GroupPatch): Promise<void>;
  deleteGroup(
    groupId: string,
    options: { moveItemsToGroupId?: string; deleteItems?: boolean },
  ): Promise<void>;
  createItem(groupId: string, item: DashyItem): Promise<void>;
  updateItem(groupId: string, itemId: string, patch: ItemPatch): Promise<void>;
  deleteItem(groupId: string, itemId: string): Promise<void>;
  moveItem(
    groupId: string,
    itemId: string,
    targetGroupId: string,
    targetIndex?: number,
  ): Promise<void>;
  moveItems(
    items: readonly { groupId: string; itemId: string }[],
    targetGroupId: string,
    targetIndex?: number,
  ): Promise<void>;
  orderGroups(groupIds: string[]): Promise<void>;
  orderItems(groupId: string, itemIds: string[]): Promise<void>;
  updateSettings(patch: CatalogSettingsPatch): Promise<void>;
  applyAiSuggestions(
    suggestions: readonly AiSuggestion[],
    options?: { retireEmptyGroupIds?: readonly string[]; groupPlan?: AiGroupPlan },
  ): Promise<void | AiApplyResult>;
  applyAiChangeSet?(
    jobId: string,
    suggestions: readonly AiSuggestion[],
    options?: {
      retireEmptyGroupIds?: readonly string[];
      groupPlan?: AiGroupPlan;
      conflictResolutions?: Readonly<Record<string, "keep_current" | "apply_suggestion">>;
      actor?: string;
    },
  ): Promise<AiApplyResult>;
  restoreAiChangeSet?(
    changeSetId: string,
    expectedVersion: string,
    actor?: string,
  ): Promise<AiRestoreResult>;
}

/** @deprecated Kept as a source-compatibility alias for older tests/integrations. */
export type DashyGateway = CatalogRepository;

export interface BookmarkInput {
  url?: string;
  remoteUrl?: string;
  localUrl?: string;
  title?: string;
  description?: string;
  icon?: string;
  groupId?: string;
  source?: string;
  trigger?: string;
}

export interface HttpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type AiProvider = "openai" | "deepseek";
export type AiField = "title" | "groupId" | "description" | "tags";
export type AiGroupStrategy = "existing" | "reorganize" | "rebuild";

export interface AiGroupingOptions {
  targetGroupCount: number;
  minGroupSize: number;
  maxGroupSize: number;
}

export interface AiGroupPlanEntry {
  id: string;
  name: string;
  description: string;
  parentPlanGroupId?: string;
  existingGroupId?: string;
  sourceGroupIds: string[];
  reason: string;
  confidence: number;
  itemCount: number;
}

export interface AiGroupPlan {
  summary: string;
  warnings?: string[];
  targetGroupCount: number;
  groups: AiGroupPlanEntry[];
  retireGroupIds: string[];
}

export interface AiConfigRecord {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  agentName: string;
  agentRolePrompt: string;
  agentCapabilityPrompt: string;
}

export interface AiConfigPublic {
  configured: boolean;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  agentName: string;
  agentRolePrompt: string;
  agentCapabilityPrompt: string;
}

export type AiJobScope = { type: "all" } | { type: "groups"; ids: string[] } | { type: "items"; ids: string[] };
export type AiJobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export type AiJobLifecycleStatus =
  | "queued"
  | "running"
  | "paused"
  | "failed"
  | "cancelled"
  | "awaiting_review"
  | "partially_applied"
  | "applied";

export interface AiSuggestion {
  id: string;
  groupId: string;
  itemId: string;
  field: AiField;
  currentValue: string | string[] | null;
  suggestedValue: string | string[];
  reason: string;
  confidence: number;
  status: "pending" | "applied" | "dismissed" | "kept";
  createsGroup: boolean;
  planGroupId?: string;
  appliedAt?: string;
}

export interface AiProposedGroup {
  id: string;
  name: string;
  description: string;
  reason: string;
  confidence: number;
  itemCount: number;
}

export interface AiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiResponseLog {
  sequence: number;
  at: string;
  phase: "group_planning" | "group_consolidation" | "item_analysis";
  batch: number;
  attempt: number;
  itemCount: number;
  provider: AiProvider;
  model: string;
  durationMs: number;
  timeoutMs?: number;
  timeoutStage?: "request" | "response_body";
  splitPart?: number;
  status: "success" | "error";
  finishReason?: string;
  usage?: AiUsage;
  content?: string;
  truncated?: boolean;
  error?: { code: string; message: string };
  startedAt?: string;
  endedAt?: string;
  httpStatus?: number;
  providerRequestId?: string;
  errorCategory?: AiFailureCategory;
  suggestedAction?: string;
}

export type AiFailureCategory =
  | "network_timeout"
  | "rate_limit"
  | "content_filter"
  | "invalid_json"
  | "missing_items"
  | "catalog_conflict"
  | "service_restart"
  | "provider_error"
  | "unknown";

export interface AiJobFailure {
  batch: number;
  error: { code: string; message: string };
  phase?: AiResponseLog["phase"];
  itemIds?: string[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  httpStatus?: number;
  providerRequestId?: string;
  category?: AiFailureCategory;
  suggestedAction?: string;
}

export interface AiBatchCheckpoint {
  id: string;
  phase: AiResponseLog["phase"];
  batch: number;
  itemIds: string[];
  inputDigest: string;
  status: "pending" | "running" | "succeeded" | "failed";
  batchSize: number;
  attempts: number;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  error?: AiJobFailure["error"];
}

export interface AiTopicCheckpoint {
  batch: number;
  itemIds: string[];
  candidates: Array<{
    name: string;
    description: string;
    reason: string;
    confidence: number;
    itemIds: string[];
    sampleTitles: string[];
  }>;
}

export interface AiJob {
  id: string;
  status: AiJobStatus;
  createdAt: string;
  updatedAt: string;
  /** Legacy v1 expiry. V2 tasks are retained until an administrator deletes them. */
  expiresAt?: string;
  scope: AiJobScope;
  fields: AiField[];
  allowNewGroups: boolean;
  groupStrategy: AiGroupStrategy;
  destinationScope?: "selected" | "all";
  missingOnly?: boolean;
  groupingOptions: AiGroupingOptions;
  groupPlan?: AiGroupPlan;
  phase: "queued" | "topic_extraction" | "group_planning" | "item_analysis" | "aggregation" | "review" | "applying" | "applied";
  lifecycleStatus?: AiJobLifecycleStatus;
  catalogVersion: string;
  progress: { total: number; processed: number; succeeded: number; failed: number };
  planningProgress?: { total: number; completed: number; failed: number; batchSize: number };
  failures: AiJobFailure[];
  suggestions: AiSuggestion[];
  proposedGroups: AiProposedGroup[];
  decisionStats: { total: number; changed: number; kept: number };
  responseLogs: AiResponseLog[];
  batchCheckpoints?: AiBatchCheckpoint[];
  recommendedBatchSize?: number;
  pausedAt?: string;
  logsPurgedAt?: string;
  appliedAt?: string;
  appliedCount?: number;
  /** Internal restart/retry state. It is omitted from HTTP responses. */
  failedItemIds?: string[];
  /** Internal resumable topic-extraction checkpoints. It is omitted from HTTP responses. */
  topicCheckpoints?: AiTopicCheckpoint[];
  /** Internal immutable input used to resume without re-reading changed catalog fields. */
  analysisSnapshot?: Array<{ groupId: string; groupName: string; item: CatalogItem }>;
  /** Internal catalog context used to keep prompts and parsing stable across restarts. */
  analysisCatalog?: DashyCatalog;
  applyHistory?: AiApplyResult[];
}

export interface AiJobSummary {
  id: string;
  status: AiJobStatus;
  createdAt: string;
  updatedAt: string;
  scope: AiJobScope;
  fields: AiField[];
  groupStrategy: AiGroupStrategy;
  destinationScope?: "selected" | "all";
  missingOnly?: boolean;
  groupingOptions: AiGroupingOptions;
  phase: AiJob["phase"];
  progress: AiJob["progress"];
  planningProgress?: AiJob["planningProgress"];
  failureCount: number;
  suggestionCount: number;
  keptCount: number;
  proposedGroupCount: number;
  model?: string;
  appliedAt?: string;
  appliedCount?: number;
  lifecycleStatus?: AiJobLifecycleStatus;
}

export interface AiApplyConflict {
  suggestionId: string;
  itemId: string;
  field: AiField;
  analysisValue: string | string[] | null;
  currentValue: string | string[] | null;
  suggestedValue: string | string[];
  resolution: "unresolved" | "keep_current" | "apply_suggestion";
}

export interface AiChangeOperation {
  type: "item_field" | "item_move" | "group_create" | "group_delete";
  itemId?: string;
  groupId?: string;
  field?: AiField;
  before?: unknown;
  after?: unknown;
}

export interface AiApplyResult {
  changeSetId?: string;
  status: "conflicts" | "partially_applied" | "applied";
  beforeVersion: string;
  afterVersion: string;
  appliedSuggestionIds: string[];
  skippedSuggestionIds: string[];
  conflicts: AiApplyConflict[];
  operations: AiChangeOperation[];
  backupId?: string;
  appliedAt?: string;
}

export interface AiRestoreResult {
  changeSetId: string;
  restoredAt: string;
  beforeVersion: string;
  restoredVersion: string;
  safetyBackupId: string;
}
