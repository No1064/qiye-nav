const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");
const worker = readFileSync(resolve(root, "service-worker.js"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.webmanifest"), "utf8"));

test("PWA manifest is installable and stays in the public root scope", () => {
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((icon) => icon.src === "/app-icon.svg"));
});

test("service worker caches only an explicit shell and credential-free public catalog", () => {
  const shellLiteral = worker.match(/const SHELL_PATHS = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] || "";
  assert.doesNotMatch(shellLiteral, /manage|admin|api\/v1\/catalog/);
  assert.match(worker, /url\.origin !== self\.location\.origin/);
  assert.match(worker, /request\.credentials === "omit"/);
  assert.match(worker, /url\.pathname\.startsWith\("\/manage"\)/);
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/v1\/admin\/"\)/);
  assert.doesNotMatch(worker, /caches\.match\(request\)/, "arbitrary requests must never use a global cache fallback");
});

test("catalog is network-first and a snapshot is returned only after network failure", () => {
  const strategy = worker.match(/async function catalogNetworkFirst[\s\S]*?\n}/)?.[0] || "";
  assert.match(strategy, /const network = await fetch\(request\)/);
  assert.match(strategy, /\.put\(CATALOG_PATH, taggedResponse\(network\.clone\(\), "snapshot", savedAt\)\)/);
  assert.match(strategy, /catch \(error\)[\s\S]*\.match\(CATALOG_PATH\)/);
  assert.match(worker, /headers\.set\("x-qiye-snapshot-at", savedAt\)/);
});
