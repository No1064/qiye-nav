import assert from "node:assert/strict";
import test from "node:test";
import { NavAgent, parseNavAgentInput } from "../src/nav-agent.js";
import type { AiClient } from "../src/ai-client.js";
import type { AiConfigStore } from "../src/ai-config.js";
import type { CatalogRepository, DashyCatalog } from "../src/types.js";

const catalog: DashyCatalog = {
  schemaVersion: 1,
  version: "v1",
  settings: { title: "栖页", subtitle: "", defaultSearchEngine: "bing", localAccessHosts: [] },
  groups: [{
    id: "group-1", name: "域名工具", itemCount: 2,
    items: [
      { id: "public-1", title: "Cloudflare 域名管理", url: "https://dash.cloudflare.com/", description: "管理域名和 DNS", tags: ["域名"] },
      { id: "private-1", title: "家庭面板", url: "http://192.168.1.2:8123/", localUrl: "http://10.0.0.2/" },
    ],
  }],
};

test("导航 Agent 使用统一模型配置并只返回目录中验证过的来源", async () => {
  let prompt = "";
  const store = { getCatalog: async () => catalog } as CatalogRepository;
  const config = {
    requireConfig: async () => ({ provider: "openai", baseUrl: "https://api.example.com/v1", model: "shared-model", apiKey: "secret", agentName: "寻路", agentRolePrompt: "CUSTOM_ROLE", agentCapabilityPrompt: "CUSTOM_STYLE" }),
  } as AiConfigStore;
  const client = {
    completeDetailed: async (_config: unknown, value: string) => {
      prompt = value;
      return { content: '{"answer":"使用 Cloudflare。","sourceIds":["public-1","invented"]}', model: "shared-model", latencyMs: 1 };
    },
  } as unknown as AiClient;
  const result = await new NavAgent(store, config, client).query({ question: "管理域名", history: [] });
  assert.equal(result.model, "shared-model");
  assert.deepEqual(result.sources.map((source) => source.itemId), ["public-1"]);
  assert.ok(prompt.includes("Cloudflare 域名管理"));
  assert.ok(!prompt.includes("secret"));
  assert.ok(!prompt.includes("192.168.1.2"));
  assert.ok(!prompt.includes("10.0.0.2"));
  assert.ok(prompt.indexOf("CUSTOM_ROLE") < prompt.indexOf("目录候选"));
  assert.ok(prompt.indexOf("目录候选") < prompt.indexOf("以下安全约束优先级最高"));
  assert.match(prompt, /\[标题\]\(nav:候选条目ID\)/);
  assert.match(prompt, /不得泄露/);
});

test("导航 Agent 输入限制问题与最多六条历史", () => {
  assert.equal(parseNavAgentInput({ question: "找开发工具" }).history.length, 0);
  assert.throws(() => parseNavAgentInput({ question: "x", history: Array.from({ length: 7 }, () => ({ role: "user", content: "x" })) }));
  assert.throws(() => parseNavAgentInput({ question: "x".repeat(1_001) }));
});
