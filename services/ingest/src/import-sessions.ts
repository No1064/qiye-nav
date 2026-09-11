import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { HttpError } from "./errors.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

interface ImportSession {
  id: string;
  paths: string[];
  updatedAt: string;
  expiresAt: string;
}

interface ImportSessionsDocument { schemaVersion: 1; sessions: ImportSession[] }

export class ImportSessions {
  private readonly sessions = new Map<string, ImportSession>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {}

  async initialize(): Promise<void> {
    if (!this.path) return;
    try {
      const document = JSON.parse(await readFile(resolve(this.path), "utf8")) as ImportSessionsDocument;
      if (document.schemaVersion !== 1 || !Array.isArray(document.sessions)) throw new Error("invalid sessions");
      for (const session of document.sessions) {
        if (typeof session.id !== "string" || !Array.isArray(session.paths) ||
            typeof session.updatedAt !== "string" || typeof session.expiresAt !== "string") {
          throw new Error("invalid import session");
        }
        if (Date.parse(session.expiresAt) > this.now()) this.sessions.set(session.id, session);
      }
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.persist();
        return;
      }
      throw new HttpError(500, "Import sessions file is corrupt", "import_sessions_corrupt");
    }
  }

  async reserve(sessionId: string, paths: readonly string[]): Promise<void> {
    this.prune();
    const existing = this.sessions.get(sessionId);
    const combined = new Set(existing?.paths ?? []);
    paths.forEach((path) => combined.add(path));
    if (combined.size > 100) {
      throw new HttpError(
        400,
        "An import session may reference at most 100 folder groups",
        "too_many_groups",
      );
    }
    const now = this.now();
    this.sessions.set(sessionId, {
      id: sessionId,
      paths: [...combined].sort(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    });
    await this.persist();
  }

  private prune(): void {
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= this.now()) this.sessions.delete(id);
    }
  }

  private persist(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const document: ImportSessionsDocument = {
      schemaVersion: 1,
      sessions: [...this.sessions.values()].map((session) => structuredClone(session)),
    };
    const operation = () => atomicWrite(resolve(this.path!), `${JSON.stringify(document, null, 2)}\n`);
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
