import test from "node:test";
import assert from "node:assert/strict";
import { existingGroupsForPlan, selectItems } from "../src/ai-job-model.js";
import { parseCreateAiJob } from "../src/ai-job-input.js";
import type { AiJob, DashyCatalog } from "../src/types.js";

test("inbox source stays isolated while destinations can cover all existing groups", () => {
  const catalog = { groups: [
    { id: "inbox", name: "Inbox", items: [{ id: "a" }] },
    { id: "work", name: "Work", items: [{ id: "b" }] },
  ] } as DashyCatalog;
  const job = { scope: { type: "groups", ids: ["inbox"] }, groupStrategy: "existing", destinationScope: "selected" } as AiJob;
  assert.deepEqual(existingGroupsForPlan(catalog, job).map(g => g.id), ["inbox"]);
  job.destinationScope = "all";
  assert.deepEqual(existingGroupsForPlan(catalog, job).map(g => g.id), ["inbox", "work"]);
  assert.deepEqual(selectItems(catalog, job.scope).map(row => row.item.id), ["a"]);
  job.groupStrategy = "reorganize";
  assert.deepEqual(existingGroupsForPlan(catalog, job).map(g => g.id), ["inbox"]);
});
test("destination input defaults to selected and validates explicit values", () => {
  const input = { scope: { type: "all" }, fields: ["groupId"], groupStrategy: "existing" };
  assert.equal(parseCreateAiJob(input).destinationScope, "selected");
  assert.equal(parseCreateAiJob({ ...input, destinationScope: "all" }).destinationScope, "all");
  assert.throws(() => parseCreateAiJob({ ...input, destinationScope: "unknown" }));
});

test("item scopes never expand to siblings and missing-only tasks cannot regroup", () => {
  const catalog = { groups: [{ id: "g", items: [{ id: "a" }, { id: "b" }] }] } as DashyCatalog;
  const parsed = parseCreateAiJob({ scope: { type: "items", ids: ["a"] }, fields: ["description"], missingOnly: true });
  assert.deepEqual(selectItems(catalog, parsed.scope).map(row => row.item.id), ["a"]);
  assert.throws(() => selectItems(catalog, { type: "items", ids: ["deleted"] }));
  assert.throws(() => parseCreateAiJob({ scope: { type: "items", ids: ["a", "a"] }, fields: ["description"] }));
  assert.throws(() => parseCreateAiJob({ scope: { type: "items", ids: ["a"] }, fields: ["groupId"], missingOnly: true }));
});
