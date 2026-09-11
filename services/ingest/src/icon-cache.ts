import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertPublicFetchUrl } from "./security.js";
import { parseHttpUrl } from "./url.js";
import { HttpError } from "./errors.js";
import type { CatalogItem } from "./types.js";

const TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 256 * 1024;
const MAX_FILES = 512;
export interface CachedIcon { mime: string; data: string; savedAt: number }

export function allowedIconSource(item: CatalogItem, source: string): boolean {
  try {
    const url = parseHttpUrl(source, "source");
    if (item.icon && url.href === new URL(item.icon).href) return true;
  } catch { /* Named icon identifiers are not URLs. */ }
  try {
    const host = new URL(item.url).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    const encoded = encodeURIComponent(host);
    return source === `https://www.google.com/s2/favicons?domain=${encoded}&sz=128`
      || source === `https://icon.horse/icon/${encoded}`
      || /^https:\/\/cdn\.jsdelivr\.net\/gh\/homarr-labs\/dashboard-icons\/svg\/[a-z0-9-]+\.svg$/.test(source);
  } catch { return false; }
}

export class IconCache {
  private pending = new Map<string, Promise<CachedIcon>>();
  private active = 0;
  private waiting: Array<() => void> = [];
  private failures = new Map<string, number>();
  constructor(private readonly directory: string, private readonly fetchImpl: typeof fetch = fetch,
    private readonly validate: (url: URL) => Promise<unknown> = assertPublicFetchUrl) {}

  async get(source: string): Promise<CachedIcon> {
    const key = createHash("sha256").update(source).digest("hex");
    const pending = this.pending.get(key);
    if (pending) return pending;
    if ((this.failures.get(key) || 0) > Date.now()) throw new HttpError(404, "Icon temporarily unavailable", "icon_unavailable");
    const result = this.readOrFetch(key, source).catch((error) => {
      this.failures.set(key, Date.now() + 5 * 60 * 1000);
      if (this.failures.size > MAX_FILES) this.failures.delete(this.failures.keys().next().value!);
      throw error;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, result);
    return result;
  }
  private async readOrFetch(key: string, source: string): Promise<CachedIcon> {
    const path = join(this.directory, `${key}.json`);
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as CachedIcon;
      if (Date.now() - value.savedAt < TTL && typeof value.data === "string" && value.data.length <= MAX_BYTES * 2 && /^image\//.test(value.mime)) return value;
    } catch { /* Cache misses do not block icon rendering. */ }
    let current = parseHttpUrl(source, "source");
    if (this.active >= 8) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      for (let redirect = 0; redirect <= 5; redirect++) {
        await this.validate(current);
        const response = await this.fetchImpl(current, { redirect: "manual", signal: controller.signal, headers: { accept: "image/*", "user-agent": "QiyeIconCache/1.0" } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || redirect === 5) break;
          current = parseHttpUrl(new URL(location, current).href, "redirect");
          continue;
        }
        const mime = (response.headers.get("content-type") || "").split(";")[0]!.trim().toLowerCase();
        if (!response.ok || !["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon", "image/avif"].includes(mime)) { await response.body?.cancel(); break; }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        if (!reader) break;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Icon exceeds size limit"); }
          chunks.push(chunk.value);
        }
        if (!size) break;
        const value: CachedIcon = { mime, data: Buffer.concat(chunks).toString("base64"), savedAt: Date.now() };
        await mkdir(this.directory, { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, path); }
        finally { await rm(temporary, { force: true }); }
        await this.prune();
        return value;
      }
      throw new Error("No image returned");
    } catch { throw new HttpError(404, "Icon unavailable", "icon_unavailable"); }
    finally { clearTimeout(timeout); const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
  private async prune(): Promise<void> {
    const files = (await readdir(this.directory)).filter((name) => name.endsWith(".json"));
    if (files.length <= MAX_FILES) return;
    const dated = await Promise.all(files.map(async (name) => ({ name, modified: (await stat(join(this.directory, name)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
    dated.sort((a, b) => a.modified - b.modified);
    await Promise.all(dated.slice(0, dated.length - MAX_FILES).map(({ name }) => rm(join(this.directory, name), { force: true })));
  }
}
