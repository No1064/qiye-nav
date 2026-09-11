import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiClient } from "../src/ai-client.js";
import { AiConfigStore, DEFAULT_AGENT_CONFIG } from "../src/ai-config.js";
import { AiJobs } from "../src/ai-jobs.js";
import { CatalogStore } from "../src/catalog-store.js";

async function fixture(
  responseContent: string | ((call: number, prompt: string) => string | Response) = '{"items":[]}',
  retryDelaysMs: number[] = [],
) {
  const directory = await mkdtemp(join(tmpdir(), "nav-ai-test-"));
  const catalog = await CatalogStore.open({
    catalogPath: join(directory, "catalog.json"),
    backupDir: join(directory, "backups"),
    defaultGroup: "Inbox",
  });
  const groupId = (await catalog.getCatalog()).groups[0]!.id;
  await catalog.createItem(groupId, { title: "Old", url: "https://example.com/" });
  const config = new AiConfigStore(join(directory, "ai.enc.json"), Buffer.alloc(32, 7));
  await config.update({
    provider: "deepseek",
    baseUrl: "https://ai.example.com/v1",
    model: "model",
    apiKey: "top-secret-key",
  });
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const client = new AiClient({
    assertUrl: async () => undefined,
    fetchImpl: async (_url, init) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      calls += 1;
      const request = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      const result = typeof responseContent === "function"
        ? responseContent(calls, request.messages?.[0]?.content ?? "")
        : responseContent;
      if (result instanceof Response) return result;
      const content = result;
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const jobs = new AiJobs({
    path: join(directory, "jobs.json"), store: catalog, configStore: config,
    client, retryDelaysMs,
  });
  await jobs.initialize();
  return {
    directory, catalog, config, jobs, groupId,
    getMaximumActive: () => maximumActive,
    getCalls: () => calls,
  };
}

async function waitForTerminal(jobs: AiJobs, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await jobs.get(id);
    if (["completed", "partial", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job did not finish");
}

test("unconfigured AI defaults to the DeepSeek preset without exposing a key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-ai-default-test-"));
  const config = new AiConfigStore(join(directory, "missing.enc.json"), Buffer.alloc(32, 6));
  assert.deepEqual(await config.publicConfig(), {
    configured: false,
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    hasApiKey: false,
    ...DEFAULT_AGENT_CONFIG,
  });
});

test("legacy encrypted AI config receives default navigation-agent fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-ai-legacy-test-"));
  const path = join(directory, "legacy.enc.json");
  const key = Buffer.alloc(32, 4);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("personal-nav-ai-config-v1", "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({
    provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "legacy-model", apiKey: "legacy-key",
  }), "utf8"), cipher.final()]);
  await writeFile(path, JSON.stringify({
    version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
  }));
  const store = new AiConfigStore(path, key);
  await store.initialize();
  assert.deepEqual((await store.publicConfig()).agentName, DEFAULT_AGENT_CONFIG.agentName);
  assert.deepEqual((await store.requireConfig()).agentRolePrompt, DEFAULT_AGENT_CONFIG.agentRolePrompt);
});

test("DeepSeek disables thinking and retries one empty connection-test completion", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const client = new AiClient({
    assertUrl: async () => undefined,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content = requests.length === 1 ? "" : '{"ok":true}';
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await client.test({
    provider: "deepseek", baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash", apiKey: "secret",
  });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.max_tokens, 256);
  assert.deepEqual(requests[0]!.thinking, { type: "disabled" });
});

test("OpenAI-compatible requests omit DeepSeek controls and truncated output is distinct", async () => {
  let request: Record<string, unknown> | undefined;
  const client = new AiClient({
    assertUrl: async () => undefined,
    fetchImpl: async (_url, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "" }, finish_reason: "length" }],
      }), { headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(client.complete({
    provider: "openai", baseUrl: "https://api.example.com/v1", model: "model", apiKey: "secret",
  }, "Return JSON"), { code: "ai_response_truncated" });
  assert.equal("thinking" in request!, false);
});

test("AI response body timeout is reported explicitly instead of as invalid JSON", async () => {
  const client = new AiClient({
    timeoutMs: 10,
    assertUrl: async () => undefined,
    fetchImpl: async (_url, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => {
            controller.error(new DOMException("The operation was aborted", "AbortError"));
          }, { once: true });
        },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(client.complete({
    provider: "deepseek", baseUrl: "https://api.example.com", model: "model", apiKey: "secret",
  }, "Return JSON"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "ai_timeout");
    assert.deepEqual((error as { details?: unknown }).details, { timeoutMs: 10, stage: "response_body" });
    return true;
  });
});

test("timed-out 20-item analysis splits into persisted 10-item sub-batches", async () => {
  const { directory, catalog, config, groupId } = await fixture();
  for (let index = 1; index < 20; index += 1) {
    await catalog.createItem(groupId, { title: `Site ${index}`, url: `https://split-${index}.example.com/` });
  }
  const path = join(directory, "split-jobs.json");
  let requestCount = 0;
  const client = new AiClient({
    assertUrl: async () => undefined,
    fetchImpl: async (_url, init) => {
      requestCount += 1;
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = request.messages[0]!.content;
      const items = JSON.parse(prompt.match(/网址：(\[[^\n]+\])$/m)![1]!) as Array<{ itemId: string }>;
      if (items.length === 20) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
          },
        });
        return new Response(body, { headers: { "content-type": "application/json" } });
      }
      if (requestCount === 3) {
        const stored = JSON.parse(await readFile(path, "utf8")) as { jobs: Array<{ progress: { succeeded: number } }> };
        assert.equal(stored.jobs[0]!.progress.succeeded, 10);
      }
      const content = JSON.stringify({ items: items.map(({ itemId }) => ({ itemId, decisions: {
        title: { action: "keep", reason: "标题准确", confidence: 0.9 },
      } })) });
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const jobs = new AiJobs({
    path, store: catalog, configStore: config, client, retryDelaysMs: [],
    phaseTimeoutMs: { item_analysis: 10 },
  });
  await jobs.initialize();
  const created = await jobs.create({ scope: { type: "all" }, fields: ["title"], allowNewGroups: false });
  const completed = await waitForTerminal(jobs, created.id);
  assert.equal(completed.status, "completed", JSON.stringify(completed.failures));
  assert.deepEqual(completed.progress, { total: 20, processed: 20, succeeded: 20, failed: 0 });
  const logs = (await jobs.logs(created.id)).logs;
  assert.deepEqual(logs.map(({ itemCount, status, splitPart }) => ({ itemCount, status, splitPart })), [
    { itemCount: 20, status: "error", splitPart: undefined },
    { itemCount: 10, status: "success", splitPart: 1 },
    { itemCount: 10, status: "success", splitPart: 2 },
  ]);
  assert.equal(logs[0]!.timeoutMs, 10);
  assert.equal(logs[0]!.timeoutStage, "response_body");
});

test("AI configuration is AES-GCM encrypted and never exposes its API key", async () => {
  const { directory, config } = await fixture();
  const raw = await readFile(join(directory, "ai.enc.json"), "utf8");
  assert.doesNotMatch(raw, /top-secret-key/);
  assert.match(raw, /aes-256-gcm/);
  assert.deepEqual(await config.publicConfig(), {
    configured: true,
    provider: "deepseek",
    baseUrl: "https://ai.example.com/v1",
    model: "model",
    hasApiKey: true,
    ...DEFAULT_AGENT_CONFIG,
  });
  await config.update({ provider: "deepseek", model: "new-model" });
  assert.equal((await config.requireConfig()).apiKey, "top-secret-key");

  const wrongKey = new AiConfigStore(join(directory, "ai.enc.json"), Buffer.alloc(32, 8));
  await assert.rejects(wrongKey.initialize(), { code: "ai_config_corrupt" });
});

test("AI jobs run one at a time, persist strict suggestions, and atomically apply once", async () => {
  let itemId = "";
  const response = () => JSON.stringify({ items: [{ itemId, decisions: {
    title: { action: "change", value: "Improved", reason: "Clearer", confidence: 0.9 },
  } }] });
  const { directory, catalog, jobs, groupId, getMaximumActive } = await fixture(response);
  itemId = (await catalog.getCatalog()).groups[0]!.items[0]!.id;
  const first = await jobs.create({ scope: { type: "all" }, fields: ["title"], allowNewGroups: false });
  const second = await jobs.create({ scope: { type: "all" }, fields: ["title"], allowNewGroups: false });
  const completed = await waitForTerminal(jobs, first.id);
  await waitForTerminal(jobs, second.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.catalogVersion, (await catalog.getCatalog()).version);
  assert.equal(completed.suggestions[0]!.suggestedValue, "Improved");
  assert.equal(getMaximumActive(), 1);
  const beforeBackups = (await readdir(join(directory, "backups"))).length;
  await catalog.applyAiSuggestions(completed.suggestions);
  const after = await catalog.getCatalog();
  assert.equal(after.groups.find((group) => group.id === groupId)!.items[0]!.title, "Improved");
  assert.equal((await readdir(join(directory, "backups"))).length, beforeBackups + 1);
  await jobs.markApplied(first.id, [completed.suggestions[0]!.id]);
  const applied = await jobs.get(first.id);
  assert.equal(applied.suggestions[0]!.status, "applied");
  assert.equal(applied.suggestions[0]!.appliedAt, applied.appliedAt);
});

test("AI apply merges unrelated additions but rejects changed target fields and reused groups", async () => {
  const { catalog, groupId } = await fixture();
  const initial = await catalog.getCatalog();
  const itemId = initial.groups[0]!.items[0]!.id;
  await catalog.createItem(groupId, { title: "Added later", url: "https://later.example.com/" });
  await catalog.applyAiSuggestions([{
    id: "suggest-title", groupId, itemId, field: "title", currentValue: "Old",
    suggestedValue: "Improved", reason: "Clearer", confidence: 0.9,
    createsGroup: false, status: "pending",
  }]);
  let current = await catalog.getCatalog();
  assert.equal(current.groups[0]!.items.length, 2);
  assert.equal(current.groups[0]!.items.find(({ id }) => id === itemId)!.title, "Improved");

  await catalog.updateItem(groupId, itemId, { description: "Changed manually" });
  await assert.rejects(catalog.applyAiSuggestions([{
    id: "suggest-description", groupId, itemId, field: "description", currentValue: null,
    suggestedValue: "AI description", reason: "Adds context", confidence: 0.8,
    createsGroup: false, status: "pending",
  }]), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "ai_suggestion_stale");
    assert.deepEqual((error as { details?: unknown }).details, { itemId, field: "description" });
    return true;
  });

  const originalName = current.groups[0]!.name;
  await catalog.updateGroup(groupId, { name: "Renamed manually" });
  await assert.rejects(catalog.applyAiSuggestions([{
    id: "suggest-tags", groupId, itemId, field: "tags", currentValue: null,
    suggestedValue: ["AI"], reason: "Searchable", confidence: 0.8,
    createsGroup: false, status: "pending",
  }], { groupPlan: {
    summary: "Reuse group", targetGroupCount: 1, retireGroupIds: [], groups: [{
      id: "plan-group", name: originalName, description: "Existing group", existingGroupId: groupId,
      sourceGroupIds: [groupId], reason: "Keep", confidence: 1, itemCount: 1,
    }],
  } }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "ai_group_plan_stale");
    assert.deepEqual((error as { details?: unknown }).details, { groupId, groupName: originalName });
    return true;
  });
  current = await catalog.getCatalog();
  assert.equal(current.groups[0]!.items.find(({ id }) => id === itemId)!.tags, undefined);
});

test("AI change sets apply non-conflicting fields and restore the complete write-before backup", async () => {
  const { catalog, groupId } = await fixture();
  const initial = await catalog.getCatalog();
  const itemId = initial.groups[0]!.items[0]!.id;
  await catalog.updateItem(groupId, itemId, { description: "Manual edit" });
  const result = await catalog.applyAiChangeSet("job-1", [{
    id: "title", groupId, itemId, field: "title", currentValue: "Old",
    suggestedValue: "Improved", reason: "Clearer", confidence: 0.9,
    createsGroup: false, status: "pending",
  }, {
    id: "description", groupId, itemId, field: "description", currentValue: null,
    suggestedValue: "AI description", reason: "Adds context", confidence: 0.8,
    createsGroup: false, status: "pending",
  }]);
  assert.equal(result.status, "partially_applied");
  assert.deepEqual(result.appliedSuggestionIds, ["title"]);
  assert.deepEqual(result.skippedSuggestionIds, ["description"]);
  assert.equal(result.conflicts[0]!.currentValue, "Manual edit");
  assert.ok(result.changeSetId);
  assert.ok(result.backupId);
  const applied = await catalog.getCatalog();
  assert.equal(applied.groups[0]!.items[0]!.title, "Improved");
  assert.equal(applied.groups[0]!.items[0]!.description, "Manual edit");

  const restored = await catalog.restoreAiChangeSet(result.changeSetId!, applied.version);
  assert.equal(restored.restoredVersion, result.beforeVersion);
  const afterRestore = await catalog.getCatalog();
  assert.equal(afterRestore.groups[0]!.items[0]!.title, "Old");
  assert.equal(afterRestore.groups[0]!.items[0]!.description, "Manual edit");
});

test("AI jobs resume from persisted item checkpoints after restart without rerunning completed items", async () => {
  const { directory, catalog, config, groupId } = await fixture();
  await catalog.createItem(groupId, { title: "Second", url: "https://second.example.com/" });
  const current = await catalog.getCatalog();
  const [first, second] = current.groups[0]!.items;
  const now = new Date().toISOString();
  await writeFile(join(directory, "jobs.json"), JSON.stringify({ schemaVersion: 4, jobs: [{
    id: "resume-job", status: "running", lifecycleStatus: "running", createdAt: now, updatedAt: now,
    scope: { type: "all" }, fields: ["title"], allowNewGroups: false, groupStrategy: "existing",
    groupingOptions: { targetGroupCount: 0, minGroupSize: 5, maxGroupSize: 40 },
    phase: "item_analysis", catalogVersion: current.version,
    progress: { total: 2, processed: 1, succeeded: 1, failed: 0 }, failures: [],
    suggestions: [{ id: "done", groupId, itemId: first!.id, field: "title", currentValue: "Old",
      suggestedValue: "First improved", reason: "Clearer", confidence: 0.9, status: "pending", createsGroup: false }],
    proposedGroups: [], decisionStats: { total: 1, changed: 1, kept: 0 }, responseLogs: [],
    analysisSnapshot: current.groups[0]!.items.map((item) => ({ groupId, groupName: current.groups[0]!.name, item })),
    batchCheckpoints: [{ id: "1", phase: "item_analysis", batch: 1, itemIds: [first!.id],
      inputDigest: "a".repeat(64), status: "succeeded", batchSize: 1, attempts: 1,
      startedAt: now, endedAt: now, durationMs: 10 }],
  }] }));
  let calls = 0;
  const resumed = new AiJobs({
    path: join(directory, "jobs.json"), store: catalog, configStore: config, retryDelaysMs: [],
    client: new AiClient({ assertUrl: async () => undefined, fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{
        itemId: second!.id, decisions: { title: { action: "change", value: "Second improved", reason: "Clearer", confidence: 0.9 } },
      }] }) } }] }), { headers: { "content-type": "application/json" } });
    } }),
  });
  await resumed.initialize();
  const completed = await waitForTerminal(resumed, "resume-job");
  assert.equal(completed.status, "completed");
  assert.equal(completed.progress.succeeded, 2);
  assert.equal(completed.suggestions.length, 2);
  assert.equal(calls, 1);
});

test("AI jobs reject corrupt persistence and strict-schema violations", async () => {
  const { directory, catalog, config } = await fixture();
  const corruptPath = join(directory, "corrupt-jobs.json");
  await writeFile(corruptPath, "not json");
  const corrupt = new AiJobs({ path: corruptPath, store: catalog, configStore: config });
  await assert.rejects(corrupt.initialize(), { code: "ai_jobs_corrupt" });

  const itemId = (await catalog.getCatalog()).groups[0]!.items[0]!.id;
  const invalid = new AiJobs({
    path: join(directory, "invalid-jobs.json"), store: catalog, configStore: config,
    client: new AiClient({
      assertUrl: async () => undefined,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        suggestions: [{ itemId, field: "url", suggestedValue: "https://evil.example", reason: "x", confidence: 1, createsGroup: false }],
      }) } }] }), { headers: { "content-type": "application/json" } }),
    }),
    retryDelaysMs: [],
  });
  await invalid.initialize();
  const job = await invalid.create({ scope: { type: "all" }, fields: ["title"], allowNewGroups: false });
  const failed = await waitForTerminal(invalid, job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failures[0]!.error.code, "ai_invalid_response");
});

test("AI jobs back off on 429/5xx and retry only failed work", async () => {
  let itemId = "";
  let valid = true;
  const response = (call: number): string | Response => {
    if (call === 1) return new Response(null, { status: 429, headers: { "retry-after": "1" } });
    if (call === 2) return new Response(null, { status: 503 });
    if (!valid) return "not-json";
    return JSON.stringify({ items: [{ itemId, decisions: {
      description: { action: "change", value: "Useful", reason: "Adds context", confidence: 0.7 },
    } }] });
  };
  const { catalog, jobs, getCalls } = await fixture(response, [0, 0]);
  itemId = (await catalog.getCatalog()).groups[0]!.items[0]!.id;
  const recovered = await jobs.create({
    scope: { type: "all" }, fields: ["description"], allowNewGroups: false,
  });
  assert.equal((await waitForTerminal(jobs, recovered.id)).status, "completed");
  assert.equal(getCalls(), 3);

  valid = false;
  const failed = await jobs.create({
    scope: { type: "all" }, fields: ["description"], allowNewGroups: false,
  });
  assert.equal((await waitForTerminal(jobs, failed.id)).status, "failed");
  valid = true;
  const retried = await jobs.retry(failed.id);
  assert.ok(["queued", "running"].includes(retried.status));
  const completed = await waitForTerminal(jobs, failed.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.progress.failed, 0);
  assert.equal(completed.progress.succeeded, 1);
});

test("AI V2 requires every selected field and records invalid responses in logs", async () => {
  let itemId = "";
  const { catalog, jobs } = await fixture(() => JSON.stringify({ items: [{
    itemId,
    decisions: {
      title: { action: "keep", reason: "Already clear", confidence: 0.9 },
    },
  }] }), []);
  itemId = (await catalog.getCatalog()).groups[0]!.items[0]!.id;
  const created = await jobs.create({
    scope: { type: "all" }, fields: ["title", "tags"], allowNewGroups: false,
    groupStrategy: "existing",
  });
  const failed = await waitForTerminal(jobs, created.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failures[0]!.error.code, "ai_invalid_response");
  const logs = await jobs.logs(created.id);
  assert.equal(logs.logs.length, 1);
  assert.equal(logs.logs[0]!.status, "error");
  assert.match(logs.logs[0]!.content!, /Already clear/);
  assert.doesNotMatch(JSON.stringify(logs), /top-secret-key/);
});

test("AI validation retries include the exact previous failure as corrective feedback", async () => {
  let itemId = "";
  const prompts: string[] = [];
  const { catalog, jobs } = await fixture((call, prompt) => {
    prompts.push(prompt);
    if (call === 1) return JSON.stringify({ topics: [{
      name: "工具", description: "工具入口", reason: "用途一致", confidence: 0.9, itemIds: [itemId],
    }] });
    if (call === 2) return "not-json";
    if (call === 3) return JSON.stringify({ summary: "重建", groups: [{
      key: "tools", parentKey: null, name: "工具", description: "工具入口",
      existingGroupId: null, reason: "用途一致", confidence: 0.9,
    }] });
    const planGroupId = prompt.match(/"planGroupId":"([0-9a-f-]{36})"/)?.[1];
    return JSON.stringify({ items: [{ itemId, decisions: {
      groupId: { action: "assign", planGroupId, reason: "用途匹配", confidence: 0.9 },
    } }] });
  }, [0]);
  itemId = (await catalog.getCatalog()).groups[0]!.items[0]!.id;
  const created = await jobs.create({
    scope: { type: "all" }, fields: ["groupId"], allowNewGroups: true, groupStrategy: "rebuild",
  });
  assert.equal((await waitForTerminal(jobs, created.id)).status, "completed");
  assert.match(prompts[2]!, /上一次响应未通过校验/);
  assert.match(prompts[2]!, /not valid JSON/);
  const logs = await jobs.logs(created.id);
  assert.deepEqual(logs.logs.slice(1, 3).map(({ attempt, status }) => [attempt, status]), [[1, "error"], [2, "success"]]);
});

test("AI V3 creates and applies a two-level company and project plan", async () => {
  let itemId = "";
  let itemPrompt = "";
  const response = (call: number, prompt: string) => {
    if (call === 1) return JSON.stringify({ topics: [{
      name: "AI 工具", description: "生成式 AI 服务", reason: "用途独立", confidence: 0.94,
      itemIds: [itemId],
    }] });
    if (call === 2) return JSON.stringify({ summary: "按公司与项目重建", groups: [{
      key: "openai", parentKey: null, name: "OpenAI", description: "公司服务",
      existingGroupId: null, reason: "同一公司", confidence: 0.96,
    }, {
      key: "chatgpt", parentKey: "openai", name: "ChatGPT", description: "对话产品",
      existingGroupId: null, reason: "独立项目", confidence: 0.94,
    }] });
    itemPrompt = prompt;
    const planGroupId = [...prompt.matchAll(/"planGroupId":"([0-9a-f-]{36})"/g)].at(-1)?.[1];
    return JSON.stringify({ items: [{ itemId, decisions: {
      title: { action: "change", value: "Old", reason: "标题准确", confidence: 0.98 },
      tags: { action: "change", value: ["AI", "对话"], reason: "便于检索", confidence: 0.88 },
      groupId: { action: "assign", planGroupId, reason: "用途匹配", confidence: 0.93 },
    } }] });
  };
  const { catalog, jobs, groupId } = await fixture(response);
  itemId = (await catalog.getCatalog()).groups[0]!.items[0]!.id;
  const created = await jobs.create({
    scope: { type: "all" }, fields: ["title", "tags", "groupId"], allowNewGroups: true,
    groupStrategy: "rebuild",
  });
  const completed = await waitForTerminal(jobs, created.id);
  assert.equal(completed.status, "completed", JSON.stringify({ failures: completed.failures, logs: await jobs.logs(created.id) }));
  assert.match(itemPrompt, /OpenAI \/ ChatGPT/);
  assert.deepEqual(completed.decisionStats, { total: 3, changed: 2, kept: 1 });
  assert.deepEqual(completed.proposedGroups.map(({ name }) => name), ["OpenAI", "ChatGPT"]);
  assert.equal(completed.proposedGroups.find(({ name }) => name === "ChatGPT")!.itemCount, 1);
  const pending = completed.suggestions.filter(({ status }) => status === "pending");
  await catalog.applyAiSuggestions(pending, {
    retireEmptyGroupIds: completed.groupPlan!.retireGroupIds,
    groupPlan: completed.groupPlan,
  });
  const result = await catalog.getCatalog();
  const parent = result.groups.find(({ name }) => name === "OpenAI");
  const project = result.groups.find(({ name }) => name === "ChatGPT");
  assert.ok(parent);
  assert.equal(project?.parentId, parent.id);
  assert.equal(project.items[0]!.id, itemId);
  assert.deepEqual(project.items[0]!.tags, ["AI", "对话"]);
  assert.equal(result.groups.some(({ id }) => id === groupId), false);
  const logs = await jobs.logs(created.id);
  assert.deepEqual(logs.logs.map(({ phase }) => phase), [
    "group_planning", "group_consolidation", "item_analysis",
  ]);
});

test("AI safely downgrades a renamed existing-group reference into a new-group proposal", async () => {
  let itemId = "";
  let existingGroupId = "";
  const { catalog, jobs, groupId } = await fixture((_call, prompt) => {
    if (prompt.startsWith("你正在从个人导航网址中提取内容主题")) {
      return JSON.stringify({ topics: [{
        name: "工具", description: "工具站点", reason: "用途一致", confidence: 0.9, itemIds: [itemId],
      }] });
    }
    if (prompt.startsWith("根据全部内容主题")) {
      return JSON.stringify({ summary: "调整名称", groups: [{
        key: "tools", parentKey: null, name: "更合适的工具分组", description: "工具站点",
        existingGroupId, reason: "名称更准确", confidence: 0.9,
      }] });
    }
    const planGroupId = prompt.match(/"planGroupId":"([0-9a-f-]{36})"/)?.[1];
    return JSON.stringify({ items: [{ itemId, decisions: {
      groupId: { action: "assign", planGroupId, reason: "用途匹配", confidence: 0.9 },
    } }] });
  });
  existingGroupId = groupId;
  itemId = (await catalog.getCatalog()).groups[0]!.items[0]!.id;
  const created = await jobs.create({
    scope: { type: "all" }, fields: ["groupId"], allowNewGroups: true, groupStrategy: "reorganize",
  });
  const completed = await waitForTerminal(jobs, created.id);
  assert.equal(completed.status, "completed", JSON.stringify(completed.failures));
  assert.equal(completed.groupPlan!.groups[0]!.existingGroupId, undefined);
  assert.equal(completed.suggestions[0]!.createsGroup, true);
});

test("AI group planning recovers omitted IDs in 40-item batches and exposes planning progress", async () => {
  let firstBatchCalls = 0;
  const response = (_call: number, prompt: string) => {
    const itemsMatch = prompt.match(/(?:网址|遗漏网址)：(\[[^\n]+\])$/m);
    if (prompt.startsWith("你正在从个人导航网址中提取内容主题")) {
      const items = JSON.parse(itemsMatch![1]!) as Array<{ itemId: string }>;
      if (items.length === 40) firstBatchCalls += 1;
      const included = items.length === 40 ? items.slice(0, -1) : items;
      return JSON.stringify({ topics: [{
        name: "工具", description: "工具站点", reason: "用途一致", confidence: 0.9,
        itemIds: included.map(({ itemId }) => itemId),
      }] });
    }
    if (prompt.startsWith("补充上一轮主题提取遗漏")) {
      const items = JSON.parse(itemsMatch![1]!) as Array<{ itemId: string }>;
      return JSON.stringify({ topics: [{
        name: "工具", description: "工具站点", reason: "补齐遗漏", confidence: 0.9,
        itemIds: items.map(({ itemId }) => itemId),
      }] });
    }
    if (prompt.startsWith("根据全部内容主题")) {
      return JSON.stringify({ summary: "按用途重建", groups: Array.from({ length: 8 }, (_, index) => ({
        key: `g${index}`, parentKey: null, name: `分组 ${index + 1}`, description: "工具分类",
        existingGroupId: null, reason: "内容匹配", confidence: 0.9,
      })) });
    }
    const items = JSON.parse(itemsMatch![1]!) as Array<{ itemId: string }>;
    const planGroupId = prompt.match(/"planGroupId":"([0-9a-f-]{36})"/)?.[1];
    return JSON.stringify({ items: items.map(({ itemId }) => ({ itemId, decisions: {
      groupId: { action: "assign", planGroupId, reason: "用途匹配", confidence: 0.9 },
    } })) });
  };
  const { catalog, jobs, groupId } = await fixture(response);
  for (let index = 1; index < 41; index += 1) {
    await catalog.createItem(groupId, { title: `Site ${index}`, url: `https://site-${index}.example.com/` });
  }
  const created = await jobs.create({
    scope: { type: "all" }, fields: ["groupId"], allowNewGroups: true, groupStrategy: "rebuild",
    groupingOptions: { targetGroupCount: 5, minGroupSize: 2, maxGroupSize: 40 },
  });
  const completed = await waitForTerminal(jobs, created.id);
  assert.equal(completed.status, "completed", JSON.stringify(completed.failures));
  assert.deepEqual(completed.planningProgress, { total: 41, completed: 41, failed: 0, batchSize: 40 });
  assert.equal(firstBatchCalls, 1);
  assert.deepEqual(completed.groupPlan?.warnings, ["模型建议 8 个叶子分组，超出目标建议范围 3-7，已保留供人工审核。"]);
  const logs = await jobs.logs(created.id);
  assert.deepEqual(logs.logs.filter(({ phase }) => phase === "group_planning").map(({ itemCount }) => itemCount), [40, 1, 1]);
});

test("AI job history migrates v1 and remains until explicitly deleted", async () => {
  const { directory, catalog, config } = await fixture();
  const catalogVersion = (await catalog.getCatalog()).version;
  const path = join(directory, "legacy-jobs.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, jobs: [{
    id: "legacy", status: "completed", createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:01:00.000Z", expiresAt: "2025-01-08T00:00:00.000Z",
    scope: { type: "all" }, fields: ["title"], allowNewGroups: false,
    catalogVersion, progress: { total: 1, processed: 1, succeeded: 1, failed: 0 },
    failures: [], suggestions: [],
  }] }));
  const jobs = new AiJobs({ path, store: catalog, configStore: config, now: () => Date.parse("2030-01-01T00:00:00Z") });
  await jobs.initialize();
  const history = await jobs.list();
  assert.equal(history.jobs[0]!.id, "legacy");
  assert.equal(history.jobs[0]!.groupStrategy, "existing");
  const persisted = JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number };
  assert.equal(persisted.schemaVersion, 4);
  await jobs.delete("legacy");
  assert.equal((await jobs.list()).jobs.length, 0);
});
