import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { parsePasswordHash } from "./password.js";

/** File override is tied to the bootstrap configuration, so the local reset script still works. */
export class AdminCredentials {
  private readonly bootstrap: string;
  constructor(private readonly path: string, private readonly username: string, private readonly initialHash: string) {
    this.bootstrap = createHash("sha256").update(`${username}\0${initialHash}`).digest("hex");
  }
  async load(): Promise<string> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (value.schemaVersion !== 1 || typeof value.passwordHash !== "string" || typeof value.bootstrap !== "string") throw new Error("Invalid administrator credential file");
      parsePasswordHash(value.passwordHash);
      return value.bootstrap === this.bootstrap && value.username === this.username ? value.passwordHash : this.initialHash;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.initialHash;
      throw error;
    }
  }
  async save(passwordHash: string): Promise<void> {
    parsePasswordHash(passwordHash);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ schemaVersion: 1, username: this.username, bootstrap: this.bootstrap, passwordHash, changedAt: new Date().toISOString() }));
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
}
