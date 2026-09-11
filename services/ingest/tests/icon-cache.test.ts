import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IconCache, allowedIconSource } from "../src/icon-cache.js";

test("icon cache coalesces requests and serves persisted bytes after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nav-icons-"));
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }); };
  const cache = new IconCache(directory, fetcher, async () => {});
  const icons = await Promise.all([cache.get("https://example.com/icon.png"), cache.get("https://example.com/icon.png")]);
  assert.equal(calls, 1);
  assert.equal(icons[0]!.data, "AQID");
  assert.equal((await new IconCache(directory, fetcher, async () => {}).get("https://example.com/icon.png")).data, "AQID");
  assert.equal(calls, 1);
});

test("icons reject arbitrary sources, HTML, and redirects to blocked destinations", async () => {
  const item = { id: "a", title: "A", url: "https://example.com", icon: "https://example.com/icon.png" };
  assert.equal(allowedIconSource(item, item.icon), true);
  assert.equal(allowedIconSource(item, "https://www.google.com/s2/favicons?domain=example.com&sz=128"), true);
  assert.equal(allowedIconSource(item, "https://arbitrary.example/secret"), false);
  const directory = await mkdtemp(join(tmpdir(), "nav-icons-block-"));
  const html = new IconCache(directory, async () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }), async () => {});
  await assert.rejects(html.get(item.icon));
  const visited: string[] = [];
  const redirects = new IconCache(directory, async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }), async url => { visited.push(url.hostname); if (url.hostname === "127.0.0.1") throw new Error("blocked"); });
  await assert.rejects(redirects.get("https://example.com/redirect"));
  assert.deepEqual(visited, ["example.com", "127.0.0.1"]);
});
