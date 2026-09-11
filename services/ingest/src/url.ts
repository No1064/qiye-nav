import { HttpError } from "./errors.js";

export function parseHttpUrl(value: unknown, field: string): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new HttpError(400, `${field} must be a non-empty URL`, "invalid_url");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, `${field} is not a valid URL`, "invalid_url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, `${field} must use http or https`, "invalid_url_scheme");
  }
  if (parsed.username || parsed.password) {
    throw new HttpError(400, `${field} must not contain credentials`, "url_credentials_forbidden");
  }
  if (!parsed.hostname) {
    throw new HttpError(400, `${field} must contain a hostname`, "invalid_url");
  }
  return parsed;
}

export function normalizeUrl(value: unknown, field = "url"): string {
  const parsed = parseHttpUrl(value, field);
  parsed.hash = "";
  return normalizeParsedUrl(parsed);
}

/** Normalize a bookmark destination without discarding client-side SPA routes. */
export function normalizeBookmarkUrl(value: unknown, field = "url"): string {
  return normalizeParsedUrl(parseHttpUrl(value, field));
}

function normalizeParsedUrl(parsed: URL): string {
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }
  if (parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  }
  return parsed.toString();
}

export function fallbackTitle(value: string): string {
  const url = new URL(value);
  return url.hostname.replace(/^www\./i, "") || value;
}
