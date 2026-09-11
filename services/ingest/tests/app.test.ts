import { IconCache } from "../src/icon-cache.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApp, type AppDependencies } from "../src/app.js";
import { AiClient } from "../src/ai-client.js";
import { AiConfigStore } from "../src/ai-config.js";
import { AiJobs } from "../src/ai-jobs.js";
import { HttpError } from "../src/errors.js";
import { HealthJobs } from "../src/health-jobs.js";
import { normalizeUrl } from "../src/url.js";
import type {
  AppConfig,
  CatalogGroup,
  DashyCatalog,
  DashyGateway,
  DashyGroup,
  DashyItem,
  DuplicateItem,
  GroupInput,
  GroupPatch,
  ItemPatch,
  CatalogSettingsPatch,
  Metadata,
} from "../src/types.js";

class FakeDashy implements DashyGateway {
  private revision = 1;
  private settings = {
    title: "栖页",
    subtitle: "Test catalog",
    defaultSearchEngine: "duckduckgo",
    localAccessHosts: ["localhost"],
  };
  duplicate?: DuplicateItem;
  groups: CatalogGroup[] = [{ id: "0", name: "收件箱", itemCount: 0, items: [] }];

  get items(): DashyItem[] {
    return this.groups.flatMap((group) =>
      group.items.map(({ id: _id, ...item }) => item),
    );
  }

  async getCatalog(): Promise<DashyCatalog> {
    return structuredClone({
      schemaVersion: 1,
      version: this.revision.toString(16).padStart(64, "0"),
      settings: this.settings,
      groups: this.groups,
    });
  }

  async listGroups(): Promise<DashyGroup[]> {
    return this.groups.map(({ items: _items, ...group }) => group);
  }

  async findDuplicate(normalizedUrls: ReadonlySet<string>): Promise<DuplicateItem | undefined> {
    if (this.duplicate) return this.duplicate;
    for (const group of this.groups) {
      for (const item of group.items) {
        if ([item.url, item.localUrl].filter(Boolean).some((url) => normalizedUrls.has(normalizeUrl(url!)))) {
          const { id: itemId, ...bookmark } = item;
          return { groupId: group.id, groupName: group.name, itemId, item: bookmark };
        }
      }
    }
    return undefined;
  }

  async addBookmark(groupId: string | undefined, item: DashyItem) {
    const group = groupId
      ? this.groups.find((candidate) => candidate.id === groupId || candidate.name === groupId)
      : this.groups[0];
    if (!group) throw new Error("group not found");
    group.items.push({ id: String(group.items.length), ...item });
    this.bump();
    const { items: _items, ...publicGroup } = group;
    return { group: publicGroup, result: { id: group.items.at(-1)!.id } };
  }

  async createGroup(input: GroupInput): Promise<void> {
    if (input.parentId) {
      const parent = this.groups.find((group) => group.id === input.parentId);
      if (!parent || parent.parentId) {
        throw new HttpError(400, "Groups support at most two levels", "invalid_group_parent");
      }
    }
    this.groups.push({ id: "", name: input.name, itemCount: 0, items: [], ...input });
    this.bump();
  }

  async updateGroup(groupId: string, patch: GroupPatch): Promise<void> {
    const group = this.group(groupId);
    if (patch.name !== undefined) group.name = patch.name;
    if (patch.icon === null) delete group.icon;
    else if (patch.icon !== undefined) group.icon = patch.icon;
    if (patch.parentId === null) delete group.parentId;
    else if (patch.parentId !== undefined) group.parentId = patch.parentId;
    this.bump();
  }

  async deleteGroup(
    groupId: string,
    options: { moveItemsToGroupId?: string; deleteItems?: boolean },
  ): Promise<void> {
    const source = this.group(groupId);
    if (options.moveItemsToGroupId) {
      this.group(options.moveItemsToGroupId).items.push(...source.items);
    }
    this.groups.splice(Number(groupId), 1);
    this.bump();
  }

  async createItem(groupId: string, item: DashyItem): Promise<void> {
    const group = this.group(groupId);
    group.items.push({ id: String(group.items.length), ...item });
    this.bump();
  }

  async updateItem(groupId: string, itemId: string, patch: ItemPatch): Promise<void> {
    const item = this.group(groupId).items[Number(itemId)];
    if (!item) throw new Error("item not found");
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete (item as unknown as Record<string, unknown>)[key];
      else (item as unknown as Record<string, unknown>)[key] = value;
    }
    this.bump();
  }

  async deleteItem(groupId: string, itemId: string): Promise<void> {
    this.group(groupId).items.splice(Number(itemId), 1);
    this.bump();
  }

  async moveItem(
    groupId: string,
    itemId: string,
    targetGroupId: string,
    targetIndex?: number,
  ): Promise<void> {
    const [item] = this.group(groupId).items.splice(Number(itemId), 1);
    const target = this.group(targetGroupId);
    target.items.splice(targetIndex ?? target.items.length, 0, item!);
    this.bump();
  }

  async moveItems(
    references: readonly { groupId: string; itemId: string }[],
    targetGroupId: string,
    targetIndex?: number,
  ): Promise<void> {
    const target = this.group(targetGroupId);
    const located = references.map(({ groupId, itemId }) => ({
      group: this.group(groupId), item: this.group(groupId).items[Number(itemId)]!,
    }));
    const moving = located.filter(({ group }) => group !== target);
    for (const { group, item } of moving) group.items.splice(group.items.indexOf(item), 1);
    target.items.splice(targetIndex ?? target.items.length, 0, ...moving.map(({ item }) => item));
    this.bump();
  }

  async orderGroups(groupIds: string[]): Promise<void> {
    this.groups = groupIds.map((id) => this.group(id));
    this.bump();
  }

  async orderItems(groupId: string, itemIds: string[]): Promise<void> {
    const group = this.group(groupId);
    const items = group.items;
    group.items = itemIds.map((id) => items[Number(id)]!);
    this.bump();
  }

  async updateSettings(patch: CatalogSettingsPatch): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    this.bump();
  }

  async applyAiSuggestions(): Promise<void> {
    this.bump();
  }

  private group(groupId: string): CatalogGroup {
    const group = this.groups[Number(groupId)];
    if (!group) throw new Error("group not found");
    return group;
  }

  private bump(): void {
    this.revision += 1;
    this.groups.forEach((group, groupIndex) => {
      group.id = String(groupIndex);
      group.items.forEach((item, itemIndex) => {
        item.id = String(itemIndex);
      });
      group.itemCount = group.items.length;
    });
  }
}

const config: AppConfig = {
  port: 3000,
  ingestToken: "ingest-secret",
  corsAllowedOrigins: new Set(["chrome-extension://test-id"]),
  allowLocalUrls: true,
  defaultGroup: "收件箱",
  fetchTimeoutMs: 1_000,
  fetchMaxBytes: 100_000,
  idempotencyTtlMs: 60_000,
  catalogPath: "/tmp/test-catalog.json",
  catalogBackupDir: "/tmp/test-catalog-backups",
  adminUsername: "admin",
  adminPasswordHash:
    "scrypt$16384$8$1$B3pg-7P7gN4tp48ewqEqyQ$Q2vxixuCMcVBfVZFZzPKSzNhgT6ZuXEbcUHhBCtQGgI",
  adminCookieSecure: false,
  aiConfigPath: "/tmp/test-ai-config.json",
  aiJobsPath: "/tmp/test-ai-jobs.json",
  importSessionsPath: "/tmp/test-import-sessions.json",
  healthJobsPath: "/tmp/test-health-jobs.json",
  aiConfigEncryptionKey: Buffer.alloc(32, 1),
};

interface TestAdminSession {
  cookie: string;
  csrfToken: string;
  readHeaders: Record<string, string>;
  writeHeaders: Record<string, string>;
}

async function withApp(
  dashy: FakeDashy,
  fetchMetadata: (url: string) => Promise<Metadata>,
  run: (baseUrl: string, admin: TestAdminSession) => Promise<void>,
  manageDir?: string,
  extra?: Partial<Pick<AppDependencies, "aiConfigStore" | "aiJobs" | "aiClient" | "healthJobs" | "saveAdminPasswordHash" | "iconCache">>,
): Promise<void> {
  const server = createServer(
    createApp({
      config,
      store: dashy,
      fetchMetadata,
      ...(manageDir ? { manageDir } : {}),
      logger: { info() {}, error() {} },
      ...extra,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const login = await fetch(`${baseUrl}/api/v1/admin/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ username: "admin", password: "correct horse battery staple" }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as { csrfToken: string };
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const admin = {
      cookie,
      csrfToken: loginBody.csrfToken,
      readHeaders: { cookie },
      writeHeaders: {
        cookie,
        "x-csrf-token": loginBody.csrfToken,
        origin: baseUrl,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
    };
    await run(baseUrl, admin);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("health is public while groups require Bearer auth", async () => {
  await withApp(new FakeDashy(), async (url) => ({ finalUrl: url }), async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "nav-ingest" });

    assert.equal((await fetch(`${baseUrl}/api/v1/groups`)).status, 401);
    const groups = await fetch(`${baseUrl}/api/v1/groups`, {
      headers: { authorization: "Bearer ingest-secret" },
    });
    assert.equal(groups.status, 200);
    assert.equal((await groups.json()).groups[0].name, "收件箱");
  });
});

async function responseJson(response: Response): Promise<any> {
  return response.json();
}

test("bookmark creation extracts metadata and replays an idempotent response", async () => {
  const dashy = new FakeDashy();
  let fetchCount = 0;
  await withApp(
    dashy,
    async (url) => {
      fetchCount += 1;
      return {
        finalUrl: url,
        title: "Fetched title",
        description: "Fetched description",
        favicon: "https://example.com/favicon.ico",
      };
    },
    async (baseUrl) => {
      const request = {
        method: "POST",
        headers: {
          authorization: "Bearer ingest-secret",
          "content-type": "application/json",
          "idempotency-key": "request-123",
          origin: "chrome-extension://test-id",
        },
        body: JSON.stringify({
          url: "https://EXAMPLE.com/docs/#intro",
          source: "chrome_extension",
          trigger: "toolbar",
        }),
      };
      const first = await fetch(`${baseUrl}/api/v1/bookmarks`, request);
      assert.equal(first.status, 201);
      assert.equal(first.headers.get("access-control-allow-origin"), "chrome-extension://test-id");
      assert.equal((await first.json()).bookmark.title, "Fetched title");

      const replay = await fetch(`${baseUrl}/api/v1/bookmarks`, request);
      assert.equal(replay.status, 201);
      assert.equal(replay.headers.get("idempotent-replayed"), "true");
      assert.equal(fetchCount, 1);
      assert.equal(dashy.items.length, 1);
      assert.equal(dashy.items[0]?.url, "https://example.com/docs#intro");
    },
  );
});

test("an explicit localUrl is saved but never fetched", async () => {
  const dashy = new FakeDashy();
  let fetchCount = 0;
  await withApp(
    dashy,
    async (url) => {
      fetchCount += 1;
      return { finalUrl: url };
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/bookmarks`, {
        method: "POST",
        headers: {
          authorization: "Bearer ingest-secret",
          "content-type": "application/json",
          "idempotency-key": "local-only-1",
        },
        body: JSON.stringify({
          localUrl: "http://192.168.1.20:5000",
          title: "NAS Photos",
          groupId: "0",
        }),
      });
      assert.equal(response.status, 201);
      assert.equal(fetchCount, 0);
      assert.equal(dashy.items[0]?.url, "http://192.168.1.20:5000/");
      assert.equal(dashy.items[0]?.localUrl, "http://192.168.1.20:5000/");
      assert.equal((await response.json()).metadata.status, "skipped");
    },
  );
});

test("a private bookmark keeps its hash route and skips blocked metadata without rejecting the save", async () => {
  const dashy = new FakeDashy();
  await withApp(
    dashy,
    async () => { throw new HttpError(400, "private target", "ssrf_target_blocked"); },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/bookmarks`, {
        method: "POST",
        headers: {
          authorization: "Bearer ingest-secret",
          "content-type": "application/json",
          "idempotency-key": "private-route-1",
        },
        body: JSON.stringify({ url: "http://172.16.0.40:9090/#/dashboard", title: "VPN" }),
      });
      assert.equal(response.status, 201);
      assert.equal(dashy.items[0]?.url, "http://172.16.0.40:9090/#/dashboard");
      assert.deepEqual((await responseJson(response)).metadata, { status: "skipped", code: "private_url" });
    },
  );
});

test("batch bookmark import creates every folder level, skips metadata, deduplicates, and replays", async () => {
  const dashy = new FakeDashy();
  let metadataCalls = 0;
  await withApp(dashy, async (url) => {
    metadataCalls += 1;
    return { finalUrl: url };
  }, async (baseUrl) => {
    const request = {
      method: "POST",
      headers: {
        authorization: "Bearer ingest-secret",
        "content-type": "application/json",
        "idempotency-key": "import-part-1",
      },
      body: JSON.stringify({
        source: "chrome_extension",
        importSessionId: "session-1",
        items: [
          { clientId: "a", url: "https://example.com/a#fragment", title: "A", folderPath: ["Work", "Docs"] },
          { clientId: "b", url: "https://example.com/a", folderPath: ["Work", "Docs"] },
          { clientId: "c", url: "javascript:alert(1)" },
        ],
      }),
    };
    const response = await fetch(`${baseUrl}/api/v1/bookmarks/batch`, request);
    assert.equal(response.status, 200);
    const result = await responseJson(response);
    assert.deepEqual(result.summary, { total: 3, created: 1, duplicate: 1, invalid: 1, failed: 0 });
    assert.deepEqual(result.results.map((entry: any) => entry.status), ["created", "duplicate", "invalid"]);
    assert.deepEqual(dashy.groups.map((group) => group.name), ["收件箱", "Work", "Docs"]);
    assert.equal(dashy.groups[2]!.parentId, dashy.groups[1]!.id);
    assert.equal(dashy.groups[2]!.items[0]!.url, "https://example.com/a#fragment");
    assert.equal(metadataCalls, 0);

    const replay = await fetch(`${baseUrl}/api/v1/bookmarks/batch`, request);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(await responseJson(replay), result);
    assert.equal(dashy.items.length, 1);
  });
});

test("metadata access-denied is distinguishable and bookmark creation degrades gracefully", async () => {
  await withApp(
    new FakeDashy(),
    async () => {
      throw new HttpError(422, "Metadata target denied automated access", "metadata_access_denied");
    },
    async (baseUrl, admin) => {
      const bookmark = await fetch(`${baseUrl}/api/v1/bookmarks`, {
        method: "POST",
        headers: {
          authorization: "Bearer ingest-secret",
          "content-type": "application/json",
          "idempotency-key": "denied-1",
        },
        body: JSON.stringify({ url: "https://example.com/blocked" }),
      });
      assert.equal(bookmark.status, 201);
      assert.deepEqual((await responseJson(bookmark)).metadata, {
        status: "failed", code: "metadata_access_denied",
      });
      const preview = await fetch(`${baseUrl}/api/v1/admin/metadata/preview`, {
        method: "POST",
        headers: admin.writeHeaders,
        body: JSON.stringify({ url: "https://example.com/blocked" }),
      });
      assert.equal(preview.status, 422);
      assert.equal((await responseJson(preview)).error.code, "metadata_access_denied");
    },
  );
});

test("AI admin APIs keep keys secret, use session/CSRF, and allow unrelated catalog updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-ai-app-"));
  const dashy = new FakeDashy();
  await dashy.createItem("0", { title: "Old title", url: "https://example.com/" });
  const aiConfigStore = new AiConfigStore(join(directory, "config.enc.json"), Buffer.alloc(32, 9));
  await aiConfigStore.initialize();
  const aiClient = new AiClient({
    assertUrl: async () => undefined,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { max_tokens: number };
      const content = request.max_tokens === 256
        ? '{"ok":true}'
        : request.max_tokens === 2_048
          ? '{"answer":"可以使用目录中的示例站点。","sourceIds":["0"]}'
          : JSON.stringify({ items: [{ itemId: "0", decisions: {
          title: { action: "change", value: "New title", reason: "Clearer", confidence: 0.8 },
        } }] });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const aiJobs = new AiJobs({
    path: join(directory, "jobs.json"), store: dashy, configStore: aiConfigStore,
    client: aiClient, retryDelaysMs: [],
  });
  await aiJobs.initialize();
  await withApp(dashy, async (url) => ({ finalUrl: url }), async (baseUrl, admin) => {
    assert.equal((await fetch(`${baseUrl}/api/v1/admin/ai/config`)).status, 401);
    const configured = await fetch(`${baseUrl}/api/v1/admin/ai/config`, {
      method: "PATCH",
      headers: admin.writeHeaders,
      body: JSON.stringify({
        provider: "deepseek", apiKey: "never-echo-this", agentName: "寻路助手",
        agentRolePrompt: "帮助我查找个人目录", agentCapabilityPrompt: "回答简洁并说明依据",
      }),
    });
    assert.equal(configured.status, 200);
    const publicConfig = await responseJson(configured);
    assert.equal(publicConfig.model, "deepseek-v4-flash");
    assert.equal(publicConfig.hasApiKey, true);
    assert.equal(publicConfig.agentName, "寻路助手");
    assert.equal(publicConfig.agentRolePrompt, "帮助我查找个人目录");
    assert.equal(JSON.stringify(publicConfig).includes("never-echo-this"), false);

    const tested = await fetch(`${baseUrl}/api/v1/admin/ai/config/test`, {
      method: "POST", headers: admin.writeHeaders,
    });
    assert.equal(tested.status, 200);
    assert.equal((await responseJson(tested)).ok, true);

    const sameOriginAgent = await fetch(`${baseUrl}/api/v1/agent/query`, {
      method: "POST",
      headers: {
        origin: baseUrl,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "目录里有什么站点？", history: [] }),
    });
    assert.equal(sameOriginAgent.status, 200);
    const agentAnswer = await responseJson(sameOriginAgent);
    assert.equal(agentAnswer.answer, "可以使用目录中的示例站点。");
    assert.deepEqual(agentAnswer.sources.map((source: { itemId: string }) => source.itemId), ["0"]);

    const crossOriginAgent = await fetch(`${baseUrl}/api/v1/agent/query`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ question: "目录里有什么站点？" }),
    });
    assert.equal(crossOriginAgent.status, 401);

    const created = await fetch(`${baseUrl}/api/v1/admin/ai/jobs`, {
      method: "POST", headers: admin.writeHeaders,
      body: JSON.stringify({ scope: { type: "all" }, fields: ["title"], allowNewGroups: false }),
    });
    assert.equal(created.status, 202);
    const createdJob = await responseJson(created);
    const completed = await waitForJob(baseUrl, admin, createdJob.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.suggestions.length, 1);
    const historyResponse = await fetch(`${baseUrl}/api/v1/admin/ai/jobs?limit=1&offset=0`, {
      headers: admin.readHeaders,
    });
    assert.equal(historyResponse.status, 200);
    const history = await responseJson(historyResponse);
    assert.equal(history.jobs.length, 1);
    assert.equal(history.jobs[0].suggestionCount, 1);
    assert.equal("suggestions" in history.jobs[0], false);
    const logsResponse = await fetch(`${baseUrl}/api/v1/admin/ai/jobs/${createdJob.id}/logs?after=0`, {
      headers: admin.readHeaders,
    });
    assert.equal(logsResponse.status, 200);
    const logs = await responseJson(logsResponse);
    assert.equal(logs.logs[0].phase, "item_analysis");
    assert.equal(JSON.stringify(logs).includes("never-echo-this"), false);
    assert.equal((await fetch(`${baseUrl}/api/v1/admin/ai/jobs/${createdJob.id}/logs`)).status, 401);

    await dashy.updateSettings({ title: "Changed catalog" });
    const current = await dashy.getCatalog();
    const applied = await fetch(`${baseUrl}/api/v1/admin/ai/jobs/${createdJob.id}/apply`, {
      method: "POST",
      headers: { ...admin.writeHeaders, "if-match": current.version },
      body: JSON.stringify({ suggestionIds: [completed.suggestions[0].id] }),
    });
    assert.equal(applied.status, 200);
    assert.equal((await responseJson(applied)).applied, 1);
  }, undefined, { aiConfigStore, aiJobs, aiClient });
});

test("health and bookmark transfer admin APIs require a session and expose dry-run results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-health-app-"));
  const dashy = new FakeDashy();
  await dashy.createItem("0", { title: "Example", url: "https://example.com/" });
  const healthJobs = new HealthJobs({
    path: join(directory, "health-jobs.json"), store: dashy,
    fetchImpl: async () => new Response(null, { status: 403 }),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    minRequestIntervalMs: 0,
  });
  await healthJobs.initialize();
  await withApp(dashy, async (url) => ({ finalUrl: url }), async (baseUrl, admin) => {
    assert.equal((await fetch(`${baseUrl}/api/v1/admin/health/jobs`)).status, 401);
    const malformedScope = await fetch(`${baseUrl}/api/v1/admin/health/jobs`, {
      method: "POST", headers: admin.writeHeaders, body: JSON.stringify({ scope: { type: "groups", ids: [] } }),
    });
    assert.equal(malformedScope.status, 400);
    const missingScope = await fetch(`${baseUrl}/api/v1/admin/health/jobs`, {
      method: "POST", headers: admin.writeHeaders, body: JSON.stringify({ scope: { type: "groups", ids: ["missing"] } }),
    });
    assert.equal(missingScope.status, 400);
    const created = await fetch(`${baseUrl}/api/v1/admin/health/jobs`, {
      method: "POST", headers: admin.writeHeaders,
      body: JSON.stringify({ includeRemote: false, scope: { type: "groups", ids: ["0"] } }),
    });
    assert.equal(created.status, 202);
    const createdJob = await responseJson(created);
    let job = createdJob;
    for (let attempt = 0; attempt < 20 && job.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      job = await responseJson(await fetch(`${baseUrl}/api/v1/admin/health/jobs/${createdJob.id}`, { headers: admin.readHeaders }));
    }
    assert.equal(job.status, "completed");
    assert.deepEqual(job.scope, { type: "groups", ids: ["0"] });
    assert.ok(Array.isArray(job.findings));

    const html = await fetch(`${baseUrl}/api/v1/admin/bookmarks/export?format=html`, { headers: admin.readHeaders });
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-disposition") ?? "", /qipage-bookmarks\.html/);
    const content = await html.text();
    assert.match(content, /NETSCAPE-Bookmark-file-1/);
    const preview = await fetch(`${baseUrl}/api/v1/admin/bookmarks/import/preview`, {
      method: "POST", headers: admin.writeHeaders, body: JSON.stringify({ format: "html", content }),
    });
    assert.equal(preview.status, 200);
    const body = await responseJson(preview);
    assert.equal(body.preview.counts.newItems, 0);
    assert.equal(body.preview.counts.duplicates, 1);

    const summary = await fetch(`${baseUrl}/api/v1/health/summary`);
    assert.equal(summary.status, 200);
    const summaryBody = await responseJson(summary);
    assert.equal(summaryBody.schemaVersion, 1);
    assert.equal(summaryBody.jobId, createdJob.id);
    assert.equal(summaryBody.jobStatus, "completed");
    assert.equal(summaryBody.counts.duplicates, 0);
    assert.equal(summaryBody.counts.missingMetadata, 1);
    assert.deepEqual(summaryBody.scope, { type: "groups", ids: ["0"] });
  }, undefined, { healthJobs });
});

async function waitForJob(baseUrl: string, admin: TestAdminSession, id: string): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/v1/admin/ai/jobs/${id}`, {
      headers: admin.readHeaders,
    });
    const job = await responseJson(response);
    if (["completed", "partial", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("AI job did not finish");
}

test("admin catalog supports group and item CRUD, move, and both order scopes", async () => {
  const dashy = new FakeDashy();
  await withApp(dashy, async (url) => ({ finalUrl: url }), async (baseUrl, admin) => {
    const initialResponse = await fetch(`${baseUrl}/api/v1/admin/catalog`, {
      headers: admin.readHeaders,
    });
    assert.equal(initialResponse.status, 200);
    let catalog = await responseJson(initialResponse);
    assert.equal(initialResponse.headers.get("etag"), `"${catalog.version}"`);
    assert.deepEqual(catalog.groups[0].items, []);

    let response = await fetch(`${baseUrl}/api/v1/admin/groups`, {
      method: "POST",
      headers: { ...admin.writeHeaders, "if-match": `"${catalog.version}-gzip"` },
      body: JSON.stringify({ name: "Tools", icon: "fas fa-toolbox" }),
    });
    assert.equal(response.status, 201);
    catalog = await responseJson(response);
    assert.equal(catalog.groups[1].name, "Tools");

    response = await fetch(`${baseUrl}/api/v1/admin/items`, {
      method: "POST",
      headers: { ...admin.writeHeaders, "if-match": catalog.version },
      body: JSON.stringify({
        groupId: "1",
        url: "https://example.com/docs#top",
        localUrl: "http://192.168.1.20:8080",
        title: "Docs",
        tags: ["reference"],
      }),
    });
    assert.equal(response.status, 201);
    catalog = await responseJson(response);
    assert.equal(catalog.groups[1].items[0].url, "https://example.com/docs#top");
    assert.equal(catalog.groups[1].items[0].localUrl, "http://192.168.1.20:8080/");

    response = await fetch(`${baseUrl}/api/v1/admin/groups/1/items/0`, {
      method: "PATCH",
      headers: { ...admin.writeHeaders, "if-match": catalog.version },
      body: JSON.stringify({ title: "Nav Docs", description: "Reference", localUrl: null }),
    });
    assert.equal(response.status, 200);
    catalog = await responseJson(response);
    assert.equal(catalog.groups[1].items[0].title, "Nav Docs");
    assert.equal(catalog.groups[1].items[0].localUrl, undefined);

    response = await fetch(`${baseUrl}/api/v1/admin/groups/1/items/0/move`, {
      method: "POST",
      headers: { ...admin.writeHeaders, "if-match": catalog.version },
      body: JSON.stringify({ targetGroupId: "0", targetIndex: 0 }),
    });
    assert.equal(response.status, 200);
    catalog = await responseJson(response);
    assert.equal(catalog.groups[0].items[0].title, "Nav Docs");

    response = await fetch(`${baseUrl}/api/v1/admin/items`, {
      method: "POST",
      headers: { ...admin.writeHeaders, "if-match": catalog.version },
      body: JSON.stringify({ groupId: "0", url: "https://second.example.com", title: "Second" }),
    });
    assert.equal(response.status, 201);
    catalog = await responseJson(response);

    response = await fetch(`${baseUrl}/api/v1/admin/order`, {
      method: "PUT",
      headers: { ...admin.writeHeaders, "if-match": catalog.version },
      body: JSON.stringify({ scope: "items", groupId: "0", itemIds: ["1", "0"] }),
    });
    assert.equal(response.status, 200);
    catalog = await responseJson(response);
    assert.equal(catalog.groups[0].items[0].title, "Second");

    response = await fetch(`${baseUrl}/api/v1/admin/order`, {
      method: "PUT",
      headers: { ...admin.writeHeaders, "if-match": catalog.version },
      body: JSON.stringify({ scope: "groups", groupIds: ["1", "0"] }),
    });
    assert.equal(response.status, 200);
    catalog = await responseJson(response);
    assert.equal(catalog.groups[0].name, "Tools");

    response = await fetch(`${baseUrl}/api/v1/admin/groups/0`, {
      method: "PATCH",
      headers: { ...admin.writeHeaders, "if-match": catalog.version },
      body: JSON.stringify({ name: "Apps", icon: null }),
    });
    assert.equal(response.status, 200);
    catalog = await responseJson(response);
    assert.equal(catalog.groups[0].name, "Apps");
    assert.equal(catalog.groups[0].icon, undefined);

    response = await fetch(`${baseUrl}/api/v1/admin/groups/1/items/1`, {
      method: "DELETE",
      headers: { ...admin.writeHeaders, "if-match": catalog.version },
    });
    assert.equal(response.status, 200);
    catalog = await responseJson(response);
    assert.equal(catalog.groups[1].items.length, 1);

    response = await fetch(`${baseUrl}/api/v1/admin/groups/0`, {
      method: "DELETE",
      headers: { ...admin.writeHeaders, "if-match": catalog.version },
    });
    assert.equal(response.status, 200);
    catalog = await responseJson(response);
    assert.equal(catalog.groups.length, 1);
    assert.equal(catalog.groups[0].name, "收件箱");
  });
});

test("admin bulk move endpoint moves selected items from multiple groups", async () => {
  const dashy = new FakeDashy();
  dashy.groups.push({ id: "1", name: "Second", itemCount: 1, items: [
    { id: "0", title: "B", url: "https://b.example.com/" },
  ] });
  dashy.groups[0]!.items.push({ id: "0", title: "A", url: "https://a.example.com/" });
  dashy.groups[0]!.itemCount = 1;
  await withApp(dashy, async (url) => ({ finalUrl: url }), async (baseUrl, admin) => {
    const catalog = await responseJson(await fetch(`${baseUrl}/api/v1/admin/catalog`, { headers: admin.readHeaders }));
    const response = await fetch(`${baseUrl}/api/v1/admin/items/move`, {
      method: "POST",
      headers: { ...admin.writeHeaders, "if-match": catalog.version },
      body: JSON.stringify({
        targetGroupId: "0",
        items: [{ groupId: "0", itemId: "0" }, { groupId: "1", itemId: "0" }],
      }),
    });
    assert.equal(response.status, 200);
    const moved = await responseJson(response);
    assert.deepEqual(moved.groups[0].items.map(({ title }: DashyItem) => title), ["A", "B"]);
    assert.equal(moved.groups[1].items.length, 0);
  });
});

test("admin group API creates two-level groups and rejects a third level", async () => {
  const dashy = new FakeDashy();
  await withApp(dashy, async (url) => ({ finalUrl: url }), async (baseUrl, admin) => {
    let catalog = await responseJson(await fetch(`${baseUrl}/api/v1/admin/catalog`, { headers: admin.readHeaders }));
    let response = await fetch(`${baseUrl}/api/v1/admin/groups`, {
      method: "POST",
      headers: { ...admin.writeHeaders, "if-match": catalog.version },
      body: JSON.stringify({ name: "Acme" }),
    });
    assert.equal(response.status, 201);
    catalog = await responseJson(response);
    const parentId = catalog.groups.find((group: CatalogGroup) => group.name === "Acme").id;

    response = await fetch(`${baseUrl}/api/v1/admin/groups`, {
      method: "POST",
      headers: { ...admin.writeHeaders, "if-match": catalog.version },
      body: JSON.stringify({ name: "Console", parentId }),
    });
    assert.equal(response.status, 201);
    catalog = await responseJson(response);
    const child = catalog.groups.find((group: CatalogGroup) => group.name === "Console");
    assert.equal(child.parentId, parentId);

    response = await fetch(`${baseUrl}/api/v1/admin/groups`, {
      method: "POST",
      headers: { ...admin.writeHeaders, "if-match": catalog.version },
      body: JSON.stringify({ name: "Third", parentId: child.id }),
    });
    assert.equal(response.status, 400);
    assert.equal((await responseJson(response)).error.code, "invalid_group_parent");
  });
});

test("admin APIs require auth and reject missing or stale catalog versions", async () => {
  const dashy = new FakeDashy();
  await withApp(dashy, async (url) => ({ finalUrl: url, title: "Preview" }), async (baseUrl, admin) => {
    assert.equal((await fetch(`${baseUrl}/api/v1/admin/catalog`)).status, 401);
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/admin/metadata/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com" }),
        })
      ).status,
      401,
    );

    const initial = await responseJson(
      await fetch(`${baseUrl}/api/v1/admin/catalog`, {
        headers: admin.readHeaders,
      }),
    );
    const missingVersion = await fetch(`${baseUrl}/api/v1/admin/groups`, {
      method: "POST",
      headers: admin.writeHeaders,
      body: JSON.stringify({ name: "First" }),
    });
    assert.equal(missingVersion.status, 428);

    const firstWrite = await fetch(`${baseUrl}/api/v1/admin/groups`, {
      method: "POST",
      headers: { ...admin.writeHeaders, "if-match": initial.version },
      body: JSON.stringify({ name: "First" }),
    });
    assert.equal(firstWrite.status, 201);

    const staleWrite = await fetch(`${baseUrl}/api/v1/admin/groups`, {
      method: "POST",
      headers: { ...admin.writeHeaders, "if-match": initial.version },
      body: JSON.stringify({ name: "Stale" }),
    });
    assert.equal(staleWrite.status, 409);
    const conflict = await responseJson(staleWrite);
    assert.equal(conflict.error.code, "version_conflict");
    assert.notEqual(conflict.error.details.currentVersion, initial.version);

    const current = await responseJson(firstWrite);
    const preview = await fetch(`${baseUrl}/api/v1/admin/metadata/preview`, {
      method: "POST",
      headers: admin.writeHeaders,
      body: JSON.stringify({ url: "https://EXAMPLE.com/#fragment" }),
    });
    assert.equal(preview.status, 200);
    assert.equal((await responseJson(preview)).url, "https://example.com/");

    const createItem = await fetch(`${baseUrl}/api/v1/admin/items`, {
      method: "POST",
      headers: { ...admin.writeHeaders, "if-match": current.version },
      body: JSON.stringify({ groupId: "0", url: "https://duplicate.example", title: "One" }),
    });
    const afterItem = await responseJson(createItem);
    const duplicate = await fetch(`${baseUrl}/api/v1/admin/items`, {
      method: "POST",
      headers: { ...admin.writeHeaders, "if-match": afterItem.version },
      body: JSON.stringify({ groupId: "0", url: "https://duplicate.example/", title: "Two" }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await responseJson(duplicate)).error.code, "duplicate_url");
  });
});

test("public catalog is token-free while settings remain authenticated and versioned", async () => {
  const dashy = new FakeDashy();
  await withApp(dashy, async (url) => ({ finalUrl: url }), async (baseUrl, admin) => {
    const publicResponse = await fetch(`${baseUrl}/api/v1/catalog`);
    assert.equal(publicResponse.status, 200);
    const publicCatalog = await responseJson(publicResponse);
    assert.deepEqual(Object.keys(publicCatalog).sort(), ["groups", "settings", "version"]);
    assert.equal(publicCatalog.settings.title, "栖页");
    assert.equal(publicCatalog.groups[0].name, "收件箱");

    assert.equal((await fetch(`${baseUrl}/api/v1/admin/settings`)).status, 401);
    const settingsResponse = await fetch(`${baseUrl}/api/v1/admin/settings`, {
      headers: admin.readHeaders,
    });
    assert.equal(settingsResponse.status, 200);
    const settings = await responseJson(settingsResponse);
    assert.deepEqual(Object.keys(settings).sort(), ["settings", "version"]);

    const invalid = await fetch(`${baseUrl}/api/v1/admin/settings`, {
      method: "PATCH",
      headers: { ...admin.writeHeaders, "if-match": settings.version },
      body: JSON.stringify({ defaultSearchEngine: "ask-jeeves" }),
    });
    assert.equal(invalid.status, 400);

    const updated = await fetch(`${baseUrl}/api/v1/admin/settings`, {
      method: "PATCH",
      headers: { ...admin.writeHeaders, "if-match": settings.version },
      body: JSON.stringify({
        title: "Home",
        subtitle: "Quiet navigation",
        defaultSearchEngine: "google",
        localAccessHosts: ["LOCALHOST", "nav.home.arpa", "localhost"],
      }),
    });
    assert.equal(updated.status, 200);
    const catalog = await responseJson(updated);
    assert.equal(catalog.settings.title, "Home");
    assert.equal(catalog.settings.defaultSearchEngine, "google");
    assert.deepEqual(catalog.settings.localAccessHosts, ["localhost", "nav.home.arpa"]);
  });
});

test("admin auth endpoints use sessions, reject Bearer access, enforce CSRF, and revoke logout", async () => {
  await withApp(new FakeDashy(), async (url) => ({ finalUrl: url }), async (baseUrl, admin) => {
    const session = await fetch(`${baseUrl}/api/v1/admin/auth/session`, {
      headers: admin.readHeaders,
    });
    assert.equal(session.status, 200);
    const sessionBody = await responseJson(session);
    assert.equal(sessionBody.authenticated, true);
    assert.equal(sessionBody.username, "admin");
    assert.equal(sessionBody.csrfToken, admin.csrfToken);
    assert.match(sessionBody.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

    const bearerOnly = await fetch(`${baseUrl}/api/v1/admin/catalog`, {
      headers: { authorization: "Bearer ingest-secret" },
    });
    assert.equal(bearerOnly.status, 401);
    assert.equal((await responseJson(bearerOnly)).error.code, "admin_unauthorized");
    assert.equal(bearerOnly.headers.get("www-authenticate"), null);

    const noCsrf = await fetch(`${baseUrl}/api/v1/admin/metadata/preview`, {
      method: "POST",
      headers: {
        cookie: admin.cookie,
        "content-type": "application/json",
        origin: baseUrl,
      },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await responseJson(noCsrf)).error.code, "csrf_invalid");

    const badOrigin = await fetch(`${baseUrl}/api/v1/admin/metadata/preview`, {
      method: "POST",
      headers: {
        ...admin.writeHeaders,
        origin: "https://evil.example",
      },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    assert.equal(badOrigin.status, 403);
    assert.equal((await responseJson(badOrigin)).error.code, "origin_forbidden");

    const logout = await fetch(`${baseUrl}/api/v1/admin/auth/logout`, {
      method: "POST",
      headers: admin.writeHeaders,
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/admin/auth/session`, {
          headers: admin.readHeaders,
        })
      ).status,
      401,
    );

    const crossSiteLogin = await fetch(`${baseUrl}/api/v1/admin/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ username: "admin", password: "correct horse battery staple" }),
    });
    assert.equal(crossSiteLogin.status, 403);
  });
});

test("root serves the shared new-tab UI without headers that block browser overlays", async () => {
  await withApp(new FakeDashy(), async (url) => ({ finalUrl: url }), async (baseUrl) => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(page.headers.get("content-security-policy"), null);
    assert.equal(page.headers.get("cross-origin-opener-policy"), null);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("cache-control"), "no-store");
    const pageHtml = await page.text();
    assert.match(pageHtml, /id="dashboard"/);
    assert.match(pageHtml, /id="theme-select"/);
    assert.match(pageHtml, /id="all-sites"/);
    assert.doesNotMatch(pageHtml, /layout-switch|目录状态/);

    const manifest = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifest.status, 404);

    const worker = await fetch(`${baseUrl}/service-worker.js`);
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.equal(worker.headers.get("cache-control"), "no-store");
    assert.match(await worker.text(), /registration\.unregister\(\)/);
  });
});

test("legacy start routes redirect directly to the shared root UI", async () => {
  await withApp(new FakeDashy(), async (url) => ({ finalUrl: url }), async (baseUrl) => {
    const redirect = await fetch(`${baseUrl}/start`, { redirect: "manual" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/");

    const slashRedirect = await fetch(`${baseUrl}/start/`, { redirect: "manual" });
    assert.equal(slashRedirect.status, 308);
    assert.equal(slashRedirect.headers.get("location"), "/");
    assert.equal(slashRedirect.headers.get("cache-control"), "no-store");

    const legacyAsset = await fetch(`${baseUrl}/start/core.js`, { redirect: "manual" });
    assert.equal(legacyAsset.status, 308);
    assert.equal(legacyAsset.headers.get("location"), "/");

    const home = await fetch(`${baseUrl}/`);
    const homeHtml = await home.text();
    assert.match(homeHtml, /id="dashboard"/);
    assert.match(homeHtml, /id="theme-select"/);
  });
});

test("manage static routes redirect safely without headers that block browser overlays", async () => {
  const manageDir = fileURLToPath(new URL("../public/manage/", import.meta.url));
  await withApp(
    new FakeDashy(),
    async (url) => ({ finalUrl: url }),
    async (baseUrl) => {
      const redirect = await fetch(`${baseUrl}/manage`, { redirect: "manual" });
      assert.equal(redirect.status, 308);
      assert.equal(redirect.headers.get("location"), "/manage/");

      const page = await fetch(`${baseUrl}/manage/`);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get("content-security-policy"), null);
      assert.equal(page.headers.get("cross-origin-opener-policy"), null);
      assert.equal(page.headers.get("x-content-type-options"), "nosniff");
      assert.equal(page.headers.get("cache-control"), "no-store");
      assert.match(page.headers.get("content-type") ?? "", /^text\/html/);

      const script = await fetch(`${baseUrl}/manage/core.js`);
      assert.equal(script.status, 200);
      assert.match(script.headers.get("content-type") ?? "", /^text\/javascript/);

      const traversal = await fetch(`${baseUrl}/manage/%2e%2e%2fpackage.json`);
      assert.equal(traversal.status, 400);

      const directory = await fetch(`${baseUrl}/manage/assets/`);
      assert.equal(directory.status, 404);
      assert.doesNotMatch(await directory.text(), new RegExp(manageDir));
    },
    manageDir,
  );
});

test("password endpoint requires a session and CSRF then revokes login after saving", async () => {
  let saved = "";
  await withApp(new FakeDashy(), async () => ({}), async (base, admin) => {
    const body = JSON.stringify({ currentPassword: "correct horse battery staple", newPassword: "new test password" });
    const target = `${base}/api/v1/admin/auth/password`;
    assert.equal((await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401);
    assert.equal((await fetch(target, { method: "POST", headers: { ...admin.readHeaders, "content-type": "application/json" }, body })).status, 403);
    const response = await fetch(target, { method: "POST", headers: admin.writeHeaders, body });
    assert.equal(response.status, 200);
    assert.match(saved, /^scrypt\$/);
    assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal((await fetch(`${base}/api/v1/admin/auth/session`, { headers: admin.readHeaders })).status, 401);
  }, undefined, { saveAdminPasswordHash: async hash => { saved = hash; } });
});

test("icon endpoint returns cacheable images only for known bookmark sources", async () => {
  const dashy = new FakeDashy();
  dashy.groups[0]!.items.push({ id: "icon-item", title: "Icon", url: "https://example.com", icon: "https://example.com/icon.png" });
  const cache = new IconCache(await mkdtemp(join(tmpdir(), "nav-icon-route-")), async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }), async () => {});
  await withApp(dashy, async () => ({}), async base => {
    const response = await fetch(`${base}/api/v1/icons/icon-item?source=${encodeURIComponent("https://example.com/icon.png")}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=604800");
    assert.match(response.headers.get("content-security-policy")!, /sandbox/);
    assert.equal((await response.arrayBuffer()).byteLength, 2);
    assert.equal((await fetch(`${base}/api/v1/icons/icon-item?source=${encodeURIComponent("https://other.example/icon.png")}`)).status, 400);
  }, undefined, { iconCache: cache });
});
