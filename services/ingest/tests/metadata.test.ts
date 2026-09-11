import assert from "node:assert/strict";
import test from "node:test";
import { createMetadataFetcher, parseHtmlMetadata } from "../src/metadata.js";

test("parseHtmlMetadata extracts social title, description, and relative favicon", () => {
  const metadata = parseHtmlMetadata(
    `<!doctype html>
      <html><head>
        <title>Fallback title</title>
        <meta property="og:title" content="  Better &amp; title  ">
        <meta name='description' content=' A useful   description. '>
        <link rel="shortcut icon" href="/assets/favicon.ico">
      </head></html>`,
    "https://example.com/articles/1",
  );

  assert.deepEqual(metadata, {
    title: "Better & title",
    description: "A useful description.",
    favicon: "https://example.com/assets/favicon.ico",
    finalUrl: "https://example.com/articles/1",
  });
});

test("parseHtmlMetadata ignores script URLs as favicons", () => {
  const metadata = parseHtmlMetadata(
    '<title>Example</title><link rel="icon" href="javascript:alert(1)">',
    "https://example.com/",
  );
  assert.equal(metadata.title, "Example");
  assert.equal(metadata.favicon, undefined);
});

test("metadata fetcher maps upstream HTTP 403 to a recognizable access-denied error", async () => {
  const fetchMetadata = createMetadataFetcher({
    timeoutMs: 1_000,
    maxBytes: 10_000,
    fetchImpl: async () => new Response(null, { status: 403 }),
  });
  await assert.rejects(fetchMetadata("https://93.184.216.34/blocked"), {
    status: 422,
    code: "metadata_access_denied",
    message: "Metadata target denied automated access",
  });
});
