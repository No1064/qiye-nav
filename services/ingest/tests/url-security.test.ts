import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicFetchUrl, isPrivateOrReservedAddress } from "../src/security.js";
import { normalizeBookmarkUrl, normalizeUrl } from "../src/url.js";

test("bookmark URLs preserve client-side routes without changing canonical duplicate matching", () => {
  assert.equal(
    normalizeBookmarkUrl("HTTPS://Example.COM:443/docs///#part"),
    "https://example.com/docs#part",
  );
  assert.equal(normalizeBookmarkUrl("http://172.16.0.40:9090/#/"), "http://172.16.0.40:9090/#/");
  assert.equal(normalizeUrl("HTTPS://Example.COM:443/docs///#part"), "https://example.com/docs");
  assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
});

test("normalizeUrl rejects credentials and non-http protocols", () => {
  assert.throws(() => normalizeUrl("https://alice:secret@example.com"), {
    code: "url_credentials_forbidden",
  });
  assert.throws(() => normalizeUrl("file:///etc/passwd"), { code: "invalid_url_scheme" });
});

test("private, Tailscale, link-local, and reserved addresses are blocked", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.1.1",
    "169.254.169.254",
    "192.168.1.2",
    "::1",
    "fd7a:115c:a1e0::1",
    "fe80::1",
  ]) {
    assert.equal(isPrivateOrReservedAddress(address), true, address);
  }
  assert.equal(isPrivateOrReservedAddress("8.8.8.8"), false);
  assert.equal(isPrivateOrReservedAddress("2606:4700:4700::1111"), false);
});

test("assertPublicFetchUrl checks every DNS answer", async () => {
  await assert.rejects(
    assertPublicFetchUrl(new URL("https://example.test"), async () => [
      { address: "8.8.8.8" },
      { address: "127.0.0.1" },
    ]),
    { code: "ssrf_target_blocked" },
  );

  await assert.doesNotReject(
    assertPublicFetchUrl(new URL("https://example.test"), async () => [
      { address: "8.8.8.8" },
    ]),
  );
});
