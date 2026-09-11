import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CatalogCorruptError, computeCatalogVersion } from "../src/catalog-schema.js";
import { CatalogStore } from "../src/catalog-store.js";
import { migrateDashyConfig } from "../src/migration.js";

async function tempStore() {
  const directory = await mkdtemp(join(tmpdir(), "nav-catalog-store-"));
  const catalogPath = join(directory, "catalog.json");
  const backupDir = join(directory, "backups");
  const store = await CatalogStore.open({ catalogPath, backupDir, defaultGroup: "Inbox" });
  return { directory, catalogPath, backupDir, store };
}

test("CatalogStore creates a valid catalog with stable UUIDs", async () => {
  const { catalogPath, store } = await tempStore();
  const initial = await store.getCatalog();
  assert.equal(initial.schemaVersion, 1);
  assert.equal(initial.settings.defaultSearchEngine, "duckduckgo");
  assert.match(initial.groups[0]?.id ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(initial.version, computeCatalogVersion(initial));

  const groupId = initial.groups[0]!.id;
  await store.createItem(groupId, { title: "Example", url: "https://example.com/" });
  const created = await store.getCatalog();
  const itemId = created.groups[0]!.items[0]!.id;
  assert.match(itemId, /^[0-9a-f-]{36}$/);
  await store.orderItems(groupId, [itemId]);
  assert.equal((await store.getCatalog()).groups[0]!.items[0]!.id, itemId);

  const disk = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.equal(disk.version, created.version);
});

test("every mutation writes a byte-for-byte backup before atomically replacing catalog", async () => {
  const { catalogPath, backupDir, store } = await tempStore();
  const before = await readFile(catalogPath, "utf8");
  await store.createGroup({ name: "Tools" });
  const backups = await readdir(backupDir);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(backupDir, backups[0]!), "utf8"), before);
  assert.notEqual(await readFile(catalogPath, "utf8"), before);
  assert.equal((await readdir(join(catalogPath, ".."))).some((name) => name.endsWith(".tmp")), false);
});

test("CatalogStore provides stable-id CRUD, migration, movement, ordering, and settings", async () => {
  const { store } = await tempStore();
  let catalog = await store.getCatalog();
  const inboxId = catalog.groups[0]!.id;
  await store.createGroup({ name: "NAS", icon: "server" });
  catalog = await store.getCatalog();
  const nasId = catalog.groups[1]!.id;
  await store.createItem(nasId, {
    title: "Photos",
    url: "https://photos.example.com/",
    localUrl: "http://192.168.1.20:5000/",
    tags: ["NAS"],
  });
  catalog = await store.getCatalog();
  const itemId = catalog.groups[1]!.items[0]!.id;
  await store.updateItem(nasId, itemId, { title: "Synology Photos", description: "Library" });
  await store.moveItem(nasId, itemId, inboxId, 0);
  await store.orderGroups([nasId, inboxId]);
  await store.updateSettings({
    title: "Home",
    defaultSearchEngine: "google",
    localAccessHosts: ["nav.home.arpa"],
  });
  catalog = await store.getCatalog();
  assert.equal(catalog.groups[0]!.id, nasId);
  assert.equal(catalog.groups[1]!.items[0]!.id, itemId);
  assert.equal(catalog.groups[1]!.items[0]!.title, "Synology Photos");
  assert.equal(catalog.settings.title, "Home");
  assert.equal(catalog.settings.defaultSearchEngine, "google");

  await store.deleteItem(inboxId, itemId);
  await store.deleteGroup(nasId, {});
  assert.deepEqual((await store.getCatalog()).groups.map((group) => group.id), [inboxId]);
});

test("CatalogStore supports two-level groups and enforces hierarchy invariants", async () => {
  const { store } = await tempStore();
  await store.createGroup({ name: "Acme" });
  await store.createGroup({ name: "Globex" });
  let catalog = await store.getCatalog();
  const acme = catalog.groups.find(({ name }) => name === "Acme")!;
  const globex = catalog.groups.find(({ name }) => name === "Globex")!;

  await store.createGroup({ name: "Console", parentId: acme.id });
  await store.createGroup({ name: "Console", parentId: globex.id });
  catalog = await store.getCatalog();
  const acmeConsole = catalog.groups.find((group) => group.name === "Console" && group.parentId === acme.id)!;
  assert.ok(acmeConsole);
  assert.equal(catalog.groups.filter(({ name }) => name === "Console").length, 2);

  await assert.rejects(
    store.createGroup({ name: "Third level", parentId: acmeConsole.id }),
    { code: "invalid_group_parent" },
  );
  await assert.rejects(store.deleteGroup(acme.id, { deleteItems: true }), { code: "group_has_children" });
  await assert.rejects(store.updateGroup(acme.id, { parentId: globex.id }), { code: "invalid_group_parent" });

  await store.updateGroup(acmeConsole.id, { parentId: null, name: "Standalone" });
  assert.equal((await store.getCatalog()).groups.find(({ id }) => id === acmeConsole.id)!.parentId, undefined);
});

test("CatalogStore bulk move is atomic across groups and accepts UUID identifiers", async () => {
  const { store } = await tempStore();
  await store.createGroup({ name: "Source A" });
  await store.createGroup({ name: "Source B" });
  await store.createGroup({ name: "Target" });
  let catalog = await store.getCatalog();
  const sourceA = catalog.groups.find(({ name }) => name === "Source A")!;
  const sourceB = catalog.groups.find(({ name }) => name === "Source B")!;
  const target = catalog.groups.find(({ name }) => name === "Target")!;
  await store.createItem(sourceA.id, { title: "A", url: "https://a.example.com/" });
  await store.createItem(sourceB.id, { title: "B", url: "https://b.example.com/" });
  catalog = await store.getCatalog();
  const itemA = catalog.groups.find(({ id }) => id === sourceA.id)!.items[0]!;
  const itemB = catalog.groups.find(({ id }) => id === sourceB.id)!.items[0]!;

  const beforeFailure = await store.getCatalog();
  await assert.rejects(store.moveItems([
    { groupId: sourceA.id, itemId: itemA.id },
    { groupId: sourceB.id, itemId: "00000000-0000-4000-8000-000000000000" },
  ], target.id), { code: "item_not_found" });
  assert.deepEqual(await store.getCatalog(), beforeFailure);

  await store.moveItems([
    { groupId: sourceA.id, itemId: itemA.id },
    { groupId: sourceB.id, itemId: itemB.id },
  ], target.id);
  catalog = await store.getCatalog();
  assert.deepEqual(catalog.groups.find(({ id }) => id === target.id)!.items.map(({ title }) => title), ["A", "B"]);
  assert.equal(catalog.groups.find(({ id }) => id === sourceA.id)!.itemCount, 0);
  assert.equal(catalog.groups.find(({ id }) => id === sourceB.id)!.itemCount, 0);
});

test("CatalogStore refuses a corrupt or version-tampered file without overwriting it", async () => {
  const { catalogPath, backupDir, store } = await tempStore();
  const corrupt = "{ this is not json";
  await writeFile(catalogPath, corrupt);
  await assert.rejects(store.getCatalog(), CatalogCorruptError);
  await assert.rejects(store.createGroup({ name: "Must not write" }), CatalogCorruptError);
  assert.equal(await readFile(catalogPath, "utf8"), corrupt);
  assert.deepEqual(await readdir(backupDir), []);

  const valid = await CatalogStore.open({
    catalogPath: join(catalogPath, "..", "other.json"),
    backupDir: join(catalogPath, "..", "other-backups"),
  });
  const document = await valid.getCatalog();
  document.settings.title = "Tampered without updating version";
  const otherPath = join(catalogPath, "..", "other.json");
  await writeFile(otherPath, JSON.stringify(document));
  await assert.rejects(valid.getCatalog(), { code: "catalog_corrupt" });
});

test("health and import change sets can restore their exact pre-change catalog", async () => {
  const { store } = await tempStore();
  let before = await store.getCatalog();
  const groupId = before.groups[0]!.id;
  await store.createItem(groupId, { title: "Keep", url: "https://keep.example/" });
  before = await store.getCatalog();
  const item = before.groups[0]!.items[0]!;

  const health = await store.applyHealthChangeSet("scan-1", [{
    id: "remove-1", type: "delete_item", itemId: item.id,
    expectedGroupId: groupId, expectedUrl: item.url,
  }]);
  assert.equal((await store.getCatalog()).groups[0]!.items.length, 0);
  const restoredHealth = await store.restoreAiChangeSet(health.changeSetId!, health.afterVersion);
  assert.equal(restoredHealth.restoredVersion, before.version);
  assert.equal((await store.getCatalog()).groups[0]!.items[0]!.id, item.id);

  const replacement = structuredClone(await store.getCatalog());
  replacement.groups = [];
  replacement.version = computeCatalogVersion(replacement);
  const imported = await store.replaceCatalogWithChangeSet(
    "json_restore", before.version, replacement,
  );
  assert.deepEqual((await store.getCatalog()).groups, []);
  const restoredImport = await store.restoreAiChangeSet(imported.changeSetId, imported.afterVersion);
  assert.equal(restoredImport.restoredVersion, before.version);
  assert.equal((await store.getCatalog()).groups[0]!.items[0]!.id, item.id);
});

test("Dashy migration keeps group/item order and supported dual-address fields", () => {
  const migrated = migrateDashyConfig({
    pageInfo: { title: "栖页", description: "Personal navigation" },
    appConfig: { webSearch: { searchEngine: "google" } },
    sections: [
      {
        name: "NAS",
        icon: "server",
        items: [
          {
            title: "Jellyfin",
            url: "https://media.example.com/",
            localUrl: "http://192.168.1.20:8096/",
            description: "Media",
            icon: "jellyfin",
            tags: ["NAS", "Media"],
            hotkey: 1,
          },
        ],
      },
      { name: "Inbox", items: [] },
    ],
  });
  assert.deepEqual(migrated.groups.map((group) => group.name), ["NAS", "Inbox"]);
  assert.deepEqual(migrated.groups[0]!.items[0], {
    id: migrated.groups[0]!.items[0]!.id,
    title: "Jellyfin",
    url: "https://media.example.com/",
    localUrl: "http://192.168.1.20:8096/",
    description: "Media",
    icon: "jellyfin",
    tags: ["NAS", "Media"],
  });
  assert.equal(migrated.settings.defaultSearchEngine, "google");
});
