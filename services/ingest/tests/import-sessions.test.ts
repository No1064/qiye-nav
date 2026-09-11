import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImportSessions } from "../src/import-sessions.js";

test("folder limits span batches and survive an import-session restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-import-sessions-"));
  const path = join(directory, "sessions.json");
  const sessions = new ImportSessions(path);
  await sessions.initialize();
  await sessions.reserve("import-1", Array.from({ length: 60 }, (_, index) => `path-${index}`));

  const reopened = new ImportSessions(path);
  await reopened.initialize();
  await reopened.reserve("import-1", Array.from({ length: 40 }, (_, index) => `next-${index}`));
  await assert.rejects(reopened.reserve("import-1", ["one-too-many"]), {
    status: 400,
    code: "too_many_groups",
  });
  await reopened.reserve("a-separate-import", ["allowed"]);
});

test("a corrupt import sessions file is rejected instead of overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-import-sessions-corrupt-"));
  const path = join(directory, "sessions.json");
  await writeFile(path, "{broken");
  await assert.rejects(new ImportSessions(path).initialize(), {
    status: 500,
    code: "import_sessions_corrupt",
  });
});
