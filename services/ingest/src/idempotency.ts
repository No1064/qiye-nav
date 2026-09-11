import { HttpError } from "./errors.js";
import type { HttpResult } from "./types.js";

interface Entry {
  fingerprint: string;
  expiresAt: number;
  promise: Promise<HttpResult>;
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly ttlMs: number) {}

  async run(
    key: string,
    fingerprint: string,
    operation: () => Promise<HttpResult>,
  ): Promise<{ result: HttpResult; replayed: boolean }> {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new HttpError(
          409,
          "Idempotency-Key was already used with a different request",
          "idempotency_conflict",
        );
      }
      return { result: await existing.promise, replayed: true };
    }

    const promise = operation();
    this.entries.set(key, {
      fingerprint,
      expiresAt: Date.now() + this.ttlMs,
      promise,
    });
    try {
      return { result: await promise, replayed: false };
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }

  private prune(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
