import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdminCredentials } from "../src/admin-credentials.js";
import { hashPassword } from "../src/password.js";

test("changed passwords survive restart, use private files, and yield to an explicit bootstrap reset", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "nav-password-")), "admin.json");
  const initial = await hashPassword("initial password");
  const changed = await hashPassword("changed password");
  const store = new AdminCredentials(path, "admin", initial);
  assert.equal(await store.load(), initial);
  await store.save(changed);
  assert.equal(await new AdminCredentials(path, "admin", initial).load(), changed);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, "utf8")).includes("changed password"), false);
  const reset = await hashPassword("reset password");
  assert.equal(await new AdminCredentials(path, "admin", reset).load(), reset);
});
