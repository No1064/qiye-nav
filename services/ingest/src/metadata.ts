import { HttpError } from "./errors.js";
import { assertPublicFetchUrl } from "./security.js";
import { parseHttpUrl } from "./url.js";
import type { Metadata } from "./types.js";

export interface MetadataFetcherOptions {
  timeoutMs: number;
  maxBytes: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, token: string) => {
    if (token.startsWith("#x") || token.startsWith("#X")) {
      const codepoint = Number.parseInt(token.slice(2), 16);
      return Number.isFinite(codepoint) ? String.fromCodePoint(codepoint) : entity;
    }
    if (token.startsWith("#")) {
      const codepoint = Number.parseInt(token.slice(1), 10);
      return Number.isFinite(codepoint) ? String.fromCodePoint(codepoint) : entity;
    }
    return named[token.toLowerCase()] ?? entity;
  });
}

function cleanText(value: string | undefined, maxLength: number): string | undefined {
  const cleaned = value ? decodeEntities(value).replace(/\s+/g, " ").trim() : "";
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const body = tag.replace(/^<\/?[a-z][^\s>]*/i, "").replace(/\/?\s*>$/, "");
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of body.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (name) attributes[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

export function parseHtmlMetadata(html: string, pageUrl: string): Metadata {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));
  const metaValue = (...names: string[]): string | undefined => {
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    const match = metas.find((meta) => wanted.has((meta.property || meta.name || "").toLowerCase()));
    return match?.content;
  };

  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = cleanText(metaValue("og:title", "twitter:title") ?? titleTag, 300);
  const description = cleanText(
    metaValue("description", "og:description", "twitter:description"),
    1_000,
  );

  let favicon: string | undefined;
  const iconLink = links.find((link) =>
    (link.rel ?? "")
      .toLowerCase()
      .split(/\s+/)
      .some((part) => ["icon", "shortcut", "apple-touch-icon", "mask-icon"].includes(part)),
  );
  if (iconLink?.href) {
    try {
      const resolved = new URL(iconLink.href, pageUrl);
      if (["http:", "https:"].includes(resolved.protocol)) favicon = resolved.toString();
    } catch {
      // Invalid icon metadata is ignored; it must not block bookmark creation.
    }
  }

  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(favicon ? { favicon } : {}),
    finalUrl: pageUrl,
  };
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(422, "Metadata response is too large", "metadata_too_large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new HttpError(422, "Metadata response is too large", "metadata_too_large");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

export function createMetadataFetcher(options: MetadataFetcherOptions): (url: string) => Promise<Metadata> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const userAgent = options.userAgent ?? "NavIngest/0.1 (+metadata fetcher)";

  return async (input: string): Promise<Metadata> => {
    let current = parseHttpUrl(input, "url");
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      await assertPublicFetchUrl(current);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "text/html,application/xhtml+xml;q=0.9",
            "user-agent": userAgent,
          },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw new HttpError(422, "Redirect had no location", "metadata_fetch_failed");
          if (redirectCount === 5) {
            throw new HttpError(422, "Too many metadata redirects", "metadata_redirect_limit");
          }
          current = parseHttpUrl(new URL(location, current).toString(), "redirectUrl");
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 403) {
            throw new HttpError(
              422,
              "Metadata target denied automated access",
              "metadata_access_denied",
            );
          }
          throw new HttpError(422, `Metadata target returned HTTP ${response.status}`, "metadata_fetch_failed");
        }

        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
          await response.body?.cancel();
          throw new HttpError(422, "Metadata target did not return HTML", "metadata_invalid_content_type");
        }
        const html = await readLimitedBody(response, options.maxBytes);
        const metadata = parseHtmlMetadata(html, current.toString());
        if (metadata.favicon) {
          try {
            await assertPublicFetchUrl(new URL(metadata.favicon));
          } catch {
            delete metadata.favicon;
          }
        }
        return metadata;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(422, "Metadata request failed", "metadata_fetch_failed");
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new HttpError(422, "Too many metadata redirects", "metadata_redirect_limit");
  };
}
