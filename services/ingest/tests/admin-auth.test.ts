import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { AdminAuth } from "../src/admin-auth.js";

const PASSWORD_HASH =
  "scrypt$16384$8$1$B3pg-7P7gN4tp48ewqEqyQ$Q2vxixuCMcVBfVZFZzPKSzNhgT6ZuXEbcUHhBCtQGgI";

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("AdminAuth stores opaque sessions, applies secure cookie policy, and enforces CSRF/origin", async () => {
  let now = 1_700_000_000_000;
  const auth = new AdminAuth(
    { username: "admin", passwordHash: PASSWORD_HASH, cookieSecure: true },
    () => now,
    async () => undefined,
  );
  const login = await auth.login("admin", "correct horse battery staple", "client-a");
  assert.match(login.cookie ?? "", /^qiye_admin=[A-Za-z0-9_-]+;/);
  assert.match(login.cookie ?? "", /HttpOnly/);
  assert.match(login.cookie ?? "", /SameSite=Strict/);
  assert.match(login.cookie ?? "", /Path=\/api\/v1\/admin/);
  assert.match(login.cookie ?? "", /Max-Age=43200/);
  assert.match(login.cookie ?? "", /Secure/);
  const cookie = login.cookie?.split(";", 1)[0] ?? "";
  assert.doesNotMatch(JSON.stringify(login.session), new RegExp(cookie.split("=")[1] ?? "never"));

  const session = auth.requireSession(request({ cookie }));
  assert.equal(session.username, "admin");
  assert.throws(
    () => auth.requireMutation(request({ cookie, origin: "https://nav.example", host: "nav.example" }), session),
    { code: "csrf_invalid" },
  );
  assert.throws(
    () => auth.requireMutation(request({
      cookie,
      "x-csrf-token": session.csrfToken,
      origin: "https://evil.example",
      host: "nav.example",
    }), session),
    { code: "origin_forbidden" },
  );
  assert.doesNotThrow(() => auth.requireMutation(request({
    cookie,
    "x-csrf-token": session.csrfToken,
    origin: "https://nav.example",
    host: "nav.example",
  }), session));

  now += 2 * 60 * 60 * 1_000;
  assert.throws(() => auth.requireSession(request({ cookie })), { code: "admin_unauthorized" });
});

test("sessions use a 12 hour absolute lifetime even when idle time is refreshed", async () => {
  let now = 10_000;
  const auth = new AdminAuth(
    { username: "admin", passwordHash: PASSWORD_HASH, cookieSecure: false },
    () => now,
    async () => undefined,
  );
  const login = await auth.login("admin", "correct horse battery staple", "client-a");
  const cookie = login.cookie?.split(";", 1)[0] ?? "";
  for (let hour = 1; hour < 12; hour += 1) {
    now = 10_000 + hour * 60 * 60 * 1_000;
    assert.equal(auth.requireSession(request({ cookie })).username, "admin");
  }
  now = 10_000 + 12 * 60 * 60 * 1_000;
  assert.throws(() => auth.requireSession(request({ cookie })), { code: "admin_unauthorized" });
});

test("failed logins receive progressive delay and rate limiting", async () => {
  const delays: number[] = [];
  const auth = new AdminAuth(
    { username: "admin", passwordHash: PASSWORD_HASH, cookieSecure: false },
    () => 1_700_000_000_000,
    async (milliseconds) => { delays.push(milliseconds); },
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(auth.login("admin", "wrong password", "client-a"), {
      code: "invalid_credentials",
    });
  }
  assert.deepEqual(delays, [100, 200, 400, 800, 1_600]);
  await assert.rejects(auth.login("admin", "correct horse battery staple", "client-a"), {
    code: "login_rate_limited",
  });
});

test("password changes verify the old password, persist before activation, and revoke every session", async () => {
  const auth = new AdminAuth({ username: "admin", passwordHash: PASSWORD_HASH, cookieSecure: false }, Date.now, async () => {});
  const first = await auth.login("admin", "correct horse battery staple", "first");
  const second = await auth.login("admin", "correct horse battery staple", "second");
  let saved = "";
  await assert.rejects(auth.changePassword("incorrect", "replacement password", "wrong", async h => { saved = h; }), { code: "invalid_credentials" });
  assert.equal(saved, "");
  await assert.rejects(auth.changePassword("correct horse battery staple", "replacement password", "save-fail", async () => { throw new Error("disk failure"); }), /disk failure/);
  assert.doesNotThrow(() => auth.requireSession(request({ cookie: first.cookie!.split(";")[0]! })));
  await auth.changePassword("correct horse battery staple", "replacement password", "change", async h => { saved = h; });
  assert.match(saved, /^scrypt\$/);
  for (const session of [first, second]) assert.throws(() => auth.requireSession(request({ cookie: session.cookie!.split(";")[0]! })), { code: "admin_unauthorized" });
  await assert.rejects(auth.login("admin", "correct horse battery staple", "old"), { code: "invalid_credentials" });
  assert.ok((await auth.login("admin", "replacement password", "new")).cookie);
});
