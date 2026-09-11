import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { computeCatalogVersion } from "../src/catalog-schema.js";
import {
  applyBookmarkImportPlan,
  createCatalogBackup,
  exportBookmarksHtml,
  exportCatalogJson,
  parseBookmarksHtml,
  parseCatalogBackup,
  planBookmarkImport,
  planJsonRestore,
} from "../src/bookmark-transfer.js";
import type { DashyCatalog } from "../src/types.js";

function fixture(): DashyCatalog {
  const parentId = randomUUID();
  const childId = randomUUID();
  const catalog: DashyCatalog = {
    schemaVersion: 1,
    version: "",
    settings: { title: "栖页 & Home", subtitle: "S", defaultSearchEngine: "duckduckgo", localAccessHosts: [".local"] },
    groups: [
      { id: parentId, name: "工作", itemCount: 1, items: [{ id: randomUUID(), title: "Docs & Mail", url: "https://example.com/docs", description: "desc", icon: "icon", tags: ["work"] }] },
      { id: childId, parentId, name: "NAS", itemCount: 1, items: [{ id: randomUUID(), title: "Storage", url: "https://nas.example.com/", localUrl: "http://nas.local/" }] },
    ],
  };
  catalog.version = computeCatalogVersion(catalog);
  return catalog;
}

test("Netscape HTML export and parser preserve two-level groups, titles, and URLs", () => {
  const html = exportBookmarksHtml(fixture());
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /Docs &amp; Mail/);
  const parsed = parseBookmarksHtml(html);
  assert.deepEqual(parsed.groups.map(({ name }) => name), ["工作", "NAS"]);
  assert.equal(parsed.groups[1]!.parentKey, parsed.groups[0]!.key);
  assert.deepEqual(parsed.items.map(({ title, url }) => ({ title, url })), [
    { title: "Docs & Mail", url: "https://example.com/docs" },
    { title: "Storage", url: "https://nas.example.com/" },
  ]);
});

test("JSON backup retains complete fields, stable IDs, counts, and hash", () => {
  const source = fixture();
  const parsed = parseCatalogBackup(exportCatalogJson(source, "2026-08-13T00:00:00.000Z"));
  assert.equal(parsed.backup?.hash, computeCatalogVersion(parsed.backup!.catalog));
  assert.deepEqual(parsed.backup?.counts, { groups: 2, items: 2 });
  assert.deepEqual(parsed.backup?.catalog.settings, source.settings);
  assert.deepEqual(parsed.backup?.catalog.groups.map(({ id }) => id), source.groups.map(({ id }) => id));
  assert.equal(parsed.items[0]!.stableId, source.groups[0]!.items[0]!.id);
  assert.deepEqual(parsed.items[0]!.tags, ["work"]);
  assert.throws(() => parseCatalogBackup({ ...createCatalogBackup(source), hash: "tampered" }), /hash verification/);
  assert.throws(() => parseCatalogBackup({ ...createCatalogBackup(source), counts: { groups: 2, items: 99 } }), /count verification/);
});

test("dry-run reports normalized duplicates, field conflicts, new groups, and only new items", () => {
  const current = fixture();
  const html = `<DL><p><DT><H3>工作</H3><DL><p>
    <DT><A HREF="HTTPS://EXAMPLE.COM:443/docs/#old">Renamed</A>
    <DT><A HREF="https://new.example.com/path/">New</A>
    </DL><p><DT><H3>阅读</H3><DL><p><DT><A HREF="https://new.example.com/path">Repeated in file</A></DL><p></DL><p>`;
  const plan = planBookmarkImport(current, parseBookmarksHtml(html));
  assert.deepEqual(plan.counts, { sourceGroups: 2, sourceItems: 3, newGroups: 1, newItems: 1, duplicates: 2, conflicts: 1 });
  assert.equal(plan.createItems[0]!.title, "New");
  assert.deepEqual(plan.conflicts[0]!.fields, ["title"]);
});

test("verified JSON can plan an empty restore and non-empty replacement needs confirmation", () => {
  const source = fixture();
  const parsed = parseCatalogBackup(exportCatalogJson(source));
  const empty = fixture();
  empty.groups = [{ ...empty.groups[0]!, itemCount: 0, items: [] }];
  empty.version = computeCatalogVersion(empty);
  const plan = planJsonRestore(empty, parsed);
  assert.equal(plan.replacingNonEmptyCatalog, false);
  assert.equal(computeCatalogVersion(plan.catalog), plan.expectedHash);
  assert.deepEqual(plan.expectedCounts, { groups: 2, items: 2 });
  assert.throws(() => planJsonRestore(source, parsed), /explicit confirmation/);
  assert.equal(planJsonRestore(source, parsed, { confirmReplaceNonEmpty: true }).replacingNonEmptyCatalog, true);
});

test("incremental plan application creates only planned records and safely reuses stable IDs", () => {
  const current = fixture();
  const groupId = randomUUID();
  const itemId = randomUUID();
  const parsed = {
    format: "json" as const,
    groups: [{ key: "new-parent", stableId: groupId, name: "New parent" }, { key: "new-child", name: "Child", parentKey: "new-parent" }],
    items: [
      { stableId: itemId, groupKey: "new-child", title: "Fresh", url: "https://fresh.example.com/" },
      { groupKey: "new-child", title: "Existing", url: "HTTPS://EXAMPLE.COM:443/docs/#fragment" },
    ],
  };
  const plan = planBookmarkImport(current, parsed);
  const applied = applyBookmarkImportPlan(current, parsed, plan);
  assert.equal(current.groups.length, 2, "input remains unchanged");
  assert.equal(applied.groups.length, 4);
  const parent = applied.groups.find(({ name }) => name === "New parent")!;
  const child = applied.groups.find(({ name }) => name === "Child")!;
  assert.equal(parent.id, groupId);
  assert.equal(child.parentId, parent.id);
  assert.equal(child.items.length, 1);
  assert.equal(child.items[0]!.id, itemId);
  assert.equal(applied.groups.reduce((sum, group) => sum + group.items.length, 0), 3);

  const stalePlan = { ...plan, createItems: [...plan.createItems, parsed.items[1]!] };
  const staleApplied = applyBookmarkImportPlan(current, parsed, stalePlan);
  assert.equal(staleApplied.groups.reduce((sum, group) => sum + group.items.length, 0), 3);
});
