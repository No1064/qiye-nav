import assert from "node:assert/strict";
import test from "node:test";
import { applyHealthActionsToCatalog } from "../src/health-governance.js";
import type { DashyCatalog } from "../src/types.js";

function catalog(): DashyCatalog {
  return { schemaVersion: 1, version: "a".repeat(64), settings: {
    title: "Test", subtitle: "", defaultSearchEngine: "google", localAccessHosts: [],
  }, groups: [{ id: "g1", name: "One", itemCount: 2, items: [
    { id: "i1", title: "A", url: "https://a.example/" },
    { id: "i2", title: "B", url: "https://b.example/" },
  ] }, { id: "g2", name: "Empty", itemCount: 0, items: [] }] };
}

test("health governance applies safe actions and isolates stale rows", () => {
  const value = catalog();
  const result = applyHealthActionsToCatalog(value, [
    { id: "delete", type: "delete_item", itemId: "i1", expectedGroupId: "g1", expectedUrl: "https://a.example/" },
    { id: "stale", type: "replace_url", itemId: "i2", expectedUrl: "https://old.example/", url: "https://new.example/" },
    { id: "empty", type: "delete_empty_group", groupId: "g2", expectedName: "Empty" },
  ]);
  assert.deepEqual(result.operations.map(({ actionId }) => actionId), ["delete", "empty"]);
  assert.deepEqual(result.conflicts.map(({ actionId }) => actionId), ["stale"]);
  assert.equal(value.groups.length, 1);
  assert.deepEqual(value.groups[0]!.items.map(({ id }) => id), ["i2"]);
});

test("metadata enrichment fills blanks only and rejects changed URLs", () => {
  const value = catalog();
  const result = applyHealthActionsToCatalog(value, [
    { id: "fill", type: "fill_metadata", itemId: "i1", expectedUrl: "https://a.example/", metadata: { title: "Replacement", description: "New description", icon: "https://a.example/icon.png" } },
    { id: "stale", type: "fill_metadata", itemId: "i2", expectedUrl: "https://old.example/", metadata: { description: "Wrong" } },
  ]);
  assert.equal(value.groups[0]!.items[0]!.title, "A");
  assert.equal(value.groups[0]!.items[0]!.description, "New description");
  assert.equal(value.groups[0]!.items[1]!.description, undefined);
  assert.equal(result.operations.length, 1);
  assert.equal(result.conflicts[0]!.reason, "field_changed");
});
