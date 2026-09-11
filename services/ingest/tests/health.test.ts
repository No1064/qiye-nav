import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HealthJobs } from "../src/health-jobs.js";
import { parseCreateHealthJob } from "../src/health-job-input.js";
import { checkRemoteUrl, scanCatalogLocally } from "../src/health-scan.js";
import type { DashyCatalog } from "../src/types.js";

function catalog(): DashyCatalog {
  return { schemaVersion: 1, version: "a".repeat(64), settings: {
    title: "Test", subtitle: "", defaultSearchEngine: "google", localAccessHosts: [],
  }, groups: [{ id: "g1", name: "One", itemCount: 4, items: [
    { id: "i1", title: "Same", url: "https://example.com/path?utm_source=x" },
    { id: "i2", title: "same", url: "https://example.com/path" },
    { id: "i3", title: "Missing", url: "https://exact.example/" },
    { id: "i4", title: "Exact", url: "https://exact.example/", description: "has data", icon: "ok" },
  ] }, { id: "empty", name: "Empty", itemCount: 0, items: [] }] };
}

const publicLookup = async () => [{ address: "93.184.216.34" }];
const ref = { groupId: "g", groupName: "Group", itemId: "i", title: "Title", url: "https://example.com/" };

test("local health scan reports duplicates, missing metadata and empty groups", () => {
  const kinds = scanCatalogLocally(catalog()).map(({ kind }) => kind);
  assert.ok(kinds.includes("exact_duplicate"));
  assert.ok(kinds.includes("suspected_duplicate"));
  assert.ok(kinds.includes("duplicate_title"));
  assert.ok(kinds.includes("missing_metadata"));
  assert.ok(kinds.includes("empty_group"));
});

test("remote health classification preserves redirects and treats 403 as authentication", async () => {
  for (const [status, category] of [[204, "ok"], [301, "permanent_redirect"], [307, "temporary_redirect"],
    [403, "auth_required"], [404, "not_found"]] as const) {
    const result = await checkRemoteUrl(ref, { fetchImpl: async () => new Response(null, {
      status, headers: status >= 300 && status < 400 ? { location: "https://new.example/" } : {},
    }), lookup: publicLookup, timeoutMs: 100 });
    assert.equal(result?.category, category);
  }
});

test("remote health check falls back from unsupported HEAD to a ranged GET", async () => {
  const requests: RequestInit[] = [];
  const result = await checkRemoteUrl(ref, { fetchImpl: async (_url, init) => {
    requests.push(init ?? {});
    return requests.length === 1 ? new Response(null, { status: 405 }) : new Response("x", { status: 200 });
  }, lookup: publicLookup, timeoutMs: 100 });
  assert.equal(result?.category, "ok");
  assert.deepEqual(requests.map(({ method }) => method), ["HEAD", "GET"]);
  assert.equal(new Headers(requests[1]?.headers).get("range"), "bytes=0-0");
});

test("remote health scan skips localhost, private DNS and Tailscale hosts", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(); };
  assert.equal(await checkRemoteUrl({ ...ref, url: "http://localhost/a" }, { fetchImpl, timeoutMs: 100 }), undefined);
  assert.equal(await checkRemoteUrl({ ...ref, url: "https://node.tailnet.ts.net/" }, { fetchImpl, timeoutMs: 100 }), undefined);
  assert.equal(await checkRemoteUrl(ref, { fetchImpl, lookup: async () => [{ address: "192.168.1.2" }], timeoutMs: 100 }), undefined);
  assert.equal(calls, 0);
});

test("health jobs persist schema v1 checkpoints and do not repeat them after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-health-test-"));
  const path = join(directory, "health.json");
  const value = catalog();
  let calls = 0;
  const options = {
    path, store: { getCatalog: async () => value }, lookup: publicLookup, minRequestIntervalMs: 0,
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 204 }); },
  };
  const jobs = new HealthJobs(options);
  await jobs.initialize();
  const created = await jobs.create();
  await jobs.waitForIdle();
  const completed = await jobs.get(created.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.progress.processed, 4);
  assert.equal(calls, 4);
  assert.equal((JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number }).schemaVersion, 1);

  const legacy = JSON.parse(await readFile(path, "utf8")) as { jobs: Array<{ scope?: unknown }> };
  delete legacy.jobs[0]?.scope;
  await writeFile(path, JSON.stringify(legacy), "utf8");

  const restarted = new HealthJobs(options);
  await restarted.initialize();
  await restarted.waitForIdle();
  assert.equal(calls, 4);
  const restored = await restarted.get(created.id);
  assert.equal(restored.status, "completed");
  assert.deepEqual(restored.scope, { type: "all" });
});

test("local-only health jobs complete without network requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-health-local-test-"));
  let calls = 0;
  const jobs = new HealthJobs({ path: join(directory, "health.json"), store: { getCatalog: async () => catalog() },
    fetchImpl: async () => { calls += 1; return new Response(); } });
  await jobs.initialize();
  const created = await jobs.create({ includeRemote: false });
  await jobs.waitForIdle();
  const completed = await jobs.get(created.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.progress.skipped, completed.progress.total);
  assert.equal(calls, 0);
});

test("health job group scopes filter local and remote work exactly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-health-scope-test-"));
  let calls = 0;
  const jobs = new HealthJobs({ path: join(directory, "health.json"), store: { getCatalog: async () => catalog() },
    fetchImpl: async () => { calls += 1; return new Response(); }, lookup: publicLookup, minRequestIntervalMs: 0 });
  await jobs.initialize();

  const single = await jobs.create({ includeRemote: true, scope: { type: "groups", ids: ["g1"] } });
  await jobs.waitForIdle();
  const singleResult = await jobs.get(single.id);
  assert.deepEqual(singleResult.scope, { type: "groups", ids: ["g1"] });
  assert.equal(singleResult.progress.total, 4);
  assert.equal(singleResult.progress.processed, 4);
  assert.equal(calls, 4);
  assert.equal(singleResult.findings.some(({ kind }) => kind === "empty_group"), false);

  const multiple = await jobs.create({ includeRemote: false, scope: { type: "groups", ids: ["g1", "empty"] } });
  await jobs.waitForIdle();
  const multipleResult = await jobs.get(multiple.id);
  assert.deepEqual(multipleResult.scope, { type: "groups", ids: ["g1", "empty"] });
  assert.equal(multipleResult.progress.total, 4);
  assert.equal(multipleResult.findings.some(({ kind, groupId }) => kind === "empty_group" && groupId === "empty"), true);
});

test("health job scope rejects malformed and nonexistent group ids", async () => {
  assert.throws(() => parseCreateHealthJob({ scope: { type: "groups", ids: [] } }), /1-100/);
  assert.throws(() => parseCreateHealthJob({ scope: { type: "groups", ids: ["g1", "g1"] } }), /duplicates/);
  assert.throws(() => parseCreateHealthJob({ scope: { type: "unknown" } }), /all or groups/);
  const directory = await mkdtemp(join(tmpdir(), "nav-health-invalid-scope-test-"));
  const jobs = new HealthJobs({ path: join(directory, "health.json"), store: { getCatalog: async () => catalog() } });
  await jobs.initialize();
  await assert.rejects(jobs.create({ scope: { type: "groups", ids: ["missing"] } }), (error: any) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "health_scope_group_not_found");
    return true;
  });
});

test("health job scope remains unchanged after persistence restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-health-scope-restart-test-"));
  const path = join(directory, "health.json");
  const options = { path, store: { getCatalog: async () => catalog() }, fetchImpl: async () => new Response(),
    lookup: publicLookup, minRequestIntervalMs: 0 };
  const jobs = new HealthJobs(options);
  await jobs.initialize();
  const created = await jobs.create({ includeRemote: false, scope: { type: "groups", ids: ["empty", "g1"] } });
  await jobs.waitForIdle();
  const restarted = new HealthJobs(options);
  await restarted.initialize();
  assert.deepEqual((await restarted.get(created.id)).scope, { type: "groups", ids: ["empty", "g1"] });
  assert.deepEqual((await restarted.list()).jobs[0]?.scope, { type: "groups", ids: ["empty", "g1"] });
});

test("health jobs reject corrupt persisted scopes and scope/snapshot mismatches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-health-corrupt-scope-test-"));
  const path = join(directory, "health.json");
  const options = { path, store: { getCatalog: async () => catalog() } };
  const jobs = new HealthJobs(options);
  await jobs.initialize();
  const created = await jobs.create({ includeRemote: false, scope: { type: "groups", ids: ["g1"] } });
  await jobs.waitForIdle();
  const document = JSON.parse(await readFile(path, "utf8")) as { jobs: Array<{ id: string; scope: unknown }> };
  document.jobs.find(({ id }) => id === created.id)!.scope = { type: "groups", ids: ["g1", "g1"] };
  await writeFile(path, JSON.stringify(document), "utf8");
  await assert.rejects(new HealthJobs(options).initialize(), (error: any) => {
    assert.equal(error.status, 500);
    assert.equal(error.code, "health_jobs_corrupt");
    return true;
  });

  document.jobs.find(({ id }) => id === created.id)!.scope = { type: "groups", ids: ["empty"] };
  await writeFile(path, JSON.stringify(document), "utf8");
  await assert.rejects(new HealthJobs(options).initialize(), (error: any) => {
    assert.equal(error.code, "health_jobs_corrupt");
    return true;
  });
});

test("health jobs support pause, resume and cancel state transitions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-health-state-test-"));
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const jobs = new HealthJobs({ path: join(directory, "health.json"), store: { getCatalog: async () => catalog() },
    lookup: publicLookup, minRequestIntervalMs: 0, fetchImpl: async () => { await pending; return new Response(); } });
  await jobs.initialize();
  const first = await jobs.create();
  while ((await jobs.get(first.id)).status !== "running") await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal((await jobs.pause(first.id)).status, "paused");
  release?.();
  await jobs.waitForIdle();
  assert.ok(["queued", "running"].includes((await jobs.resume(first.id)).status));
  await jobs.waitForIdle();
  assert.equal((await jobs.get(first.id)).status, "completed");

  const second = await jobs.create();
  assert.equal((await jobs.cancel(second.id)).status, "cancelled");
});

test("health summary counts duplicates, dead and broken links from the latest completed job", async () => {
  const { summarizeHealthJobs } = await awaitImportSummary();
  const base = { id: "j", status: "completed", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z", catalogVersion: "v1", includeRemote: true,
    scope: { type: "all" }, progress: { total: 3, processed: 3, skipped: 0, failed: 0 },
    findings: [], remoteResults: [], checkpointItemKeys: [], snapshot: { schemaVersion: 1, version: "v1", settings: {}, groups: [] } };
  const job = {
    ...base,
    findings: [
      { id: "d1", kind: "exact_duplicate", message: "dup", items: [ref] },
      { id: "d2", kind: "suspected_duplicate", message: "dup", items: [ref] },
      { id: "d3", kind: "duplicate_title", message: "dup", items: [ref] },
      { id: "m1", kind: "missing_metadata", message: "meta", items: [ref] },
      { id: "e1", kind: "empty_group", message: "empty", items: [] },
    ],
    remoteResults: [
      { item: ref, category: "not_found", checkedAt: "", durationMs: 1 },
      { item: ref, category: "timeout", checkedAt: "", durationMs: 1 },
      { item: ref, category: "dns_error", checkedAt: "", durationMs: 1 },
      { item: ref, category: "permanent_redirect", checkedAt: "", durationMs: 1 },
      { item: ref, category: "auth_required", checkedAt: "", durationMs: 1 },
    ],
  };
  const summary = summarizeHealthJobs([job]);
  assert.equal(summary.counts.duplicates, 3);
  assert.equal(summary.counts.deadLinks, 1);
  assert.equal(summary.counts.brokenLinks, 2);
  assert.equal(summary.counts.redirects, 1);
  assert.equal(summary.counts.authRequired, 1);
  assert.equal(summary.counts.missingMetadata, 1);
  assert.equal(summary.counts.emptyGroups, 1);
  assert.equal(summary.jobId, "j");
});

test("health summary returns zeros when no completed job exists", async () => {
  const { summarizeHealthJobs } = await awaitImportSummary();
  const summary = summarizeHealthJobs([]);
  assert.equal(summary.jobId, null);
  assert.deepEqual(summary.counts, {
    duplicates: 0, deadLinks: 0, brokenLinks: 0, redirects: 0, authRequired: 0, missingMetadata: 0, emptyGroups: 0,
  });
});

function awaitImportSummary() {
  return import("../src/health-summary.js");
}

test("empty group findings exclude parent containers, including parents of empty children", () => {
  const value = catalog();
  value.groups.push(
    { id: "parent", name: "Parent", items: [], itemCount: 0 },
    { id: "child", parentId: "parent", name: "Child", items: [], itemCount: 0 },
    { id: "filled-parent", name: "Filled parent", items: [], itemCount: 0 },
    { id: "filled-child", parentId: "filled-parent", name: "Filled child", items: [{ id: "nested", title: "Nested", url: "https://nested.example/" }], itemCount: 1 },
  );
  assert.deepEqual(scanCatalogLocally(value).filter(f => f.kind === "empty_group").map(f => f.groupId), ["empty", "child"]);
});

test("parent-only health scope includes children and survives persistence without widening to siblings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-health-parent-test-"));
  const path = join(directory, "health.json");
  const value = catalog();
  value.groups.push({ id: "parent", name: "Parent", itemCount: 0, items: [] });
  value.groups[0]!.parentId = "parent";
  const options = { path, store: { getCatalog: async () => value } };
  const jobs = new HealthJobs(options);
  await jobs.initialize();
  const created = await jobs.create({ includeRemote: false, scope: { type: "groups", ids: ["parent"] } });
  await jobs.waitForIdle();
  const result = await jobs.get(created.id);
  assert.equal(result.progress.total, 4);
  assert.deepEqual(result.scope, { type: "groups", ids: ["parent", "g1"] });
  assert.equal(result.findings.some(f => f.kind === "empty_group"), false);
  const reloaded = new HealthJobs(options);
  await reloaded.initialize();
  assert.equal((await reloaded.get(created.id)).progress.total, 4);
});
