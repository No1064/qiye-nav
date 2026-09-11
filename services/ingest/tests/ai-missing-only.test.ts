import assert from "node:assert/strict";
import test from "node:test";
import { parseDecisions } from "../src/ai-job-response-parser.js";
import type { AiJob, DashyCatalog } from "../src/types.js";

test("missing-only enforces preservation even when the model suggests replacing populated fields", () => {
  const items = [
    { groupId: "g", groupName: "Group", item: { id: "a", title: "Original", url: "https://example.com" } },
    { groupId: "g", groupName: "Group", item: { id: "b", title: "Other", url: "https://example.org", description: "Keep this" } },
  ];
  const job = { fields: ["title", "description"], missingOnly: true, groupStrategy: "existing" } as AiJob;
  const response = JSON.stringify({ items: items.map(({ item }) => ({ itemId: item.id, decisions: {
    title: { action: "change", value: "Renamed", reason: "Changed", confidence: 0.9 },
    description: { action: "change", value: "Suggested description", reason: "Filled", confidence: 0.9 },
  } })) });
  const decisions = parseDecisions(response, { groups: [] } as unknown as DashyCatalog, job, items);
  assert.equal(decisions.filter(d => d.status === "pending").length, 1);
  assert.equal(decisions.find(d => d.itemId === "a" && d.field === "description")?.suggestedValue, "Suggested description");
  assert.equal(decisions.find(d => d.itemId === "b" && d.field === "description")?.suggestedValue, "Keep this");
  assert.equal(decisions.find(d => d.itemId === "a" && d.field === "title")?.suggestedValue, "Original");
});
