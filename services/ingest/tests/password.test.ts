import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, parsePasswordHash, verifyPassword } from "../src/password.js";

test("scrypt password hashes are salted, parseable, and constant-format", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(parsePasswordHash(first).expected.length, 32);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("incorrect horse battery staple", first), false);
});

test("password hashing rejects short credentials and unsafe stored parameters", async () => {
  await assert.rejects(hashPassword("too-short"), /12-1024/);
  assert.throws(
    () => parsePasswordHash("scrypt$1024$8$1$c2FsdHNhbHRzYWx0c2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    /unsafe scrypt parameters/,
  );
});
