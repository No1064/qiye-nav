import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HttpError } from "./errors.js";
import { hashPassword, verifyPassword } from "./password.js";

const COOKIE_NAME = "qiye_admin";
const IDLE_TTL_MS = 2 * 60 * 60 * 1_000;
const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_SESSIONS = 100;
const MAX_LOGIN_CLIENTS = 10_000;

interface Session {
  username: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

interface LoginAttempt {
  failures: number[];
  blockedUntil: number;
}

export interface AuthConfig {
  username: string;
  passwordHash: string;
  cookieSecure: boolean;
}

export interface AuthResult {
  session: Session;
  cookie?: string;
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalText(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) result[name] = value;
  }
  return result;
}

export class AdminAuth {
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, LoginAttempt>();

  constructor(
    private readonly config: AuthConfig,
    private readonly now: () => number = Date.now,
    private readonly delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  private async authenticate(username: string, password: string, clientKey: string): Promise<number> {
    const checkedHash = this.config.passwordHash;
    const timestamp = this.now();
    this.pruneAttempts(timestamp);
    const attempt = this.attempts.get(clientKey) ?? { failures: [], blockedUntil: 0 };
    attempt.failures = attempt.failures.filter((failedAt) => failedAt > timestamp - 15 * 60 * 1_000);
    if (attempt.blockedUntil > timestamp) {
      throw new HttpError(429, "Too many login attempts; try again later", "login_rate_limited", {
        retryAfterSeconds: Math.ceil((attempt.blockedUntil - timestamp) / 1_000),
      });
    }

    let passwordValid = false;
    try {
      passwordValid = await verifyPassword(password, checkedHash);
    } catch {
      passwordValid = false;
    }
    const valid = equalText(username, this.config.username) && passwordValid && checkedHash === this.config.passwordHash;
    if (!valid) {
      attempt.failures.push(timestamp);
      const count = attempt.failures.length;
      const progressiveDelay = Math.min(2_000, 100 * 2 ** Math.min(count - 1, 5));
      if (count >= 5) attempt.blockedUntil = timestamp + Math.min(15 * 60 * 1_000, 30_000 * 2 ** (count - 5));
      this.attempts.set(clientKey, attempt);
      if (this.attempts.size > MAX_LOGIN_CLIENTS) {
        const oldest = this.attempts.keys().next().value as string | undefined;
        if (oldest) this.attempts.delete(oldest);
      }
      await this.delay(progressiveDelay);
      throw new HttpError(401, "Invalid administrator credentials", "invalid_credentials");
    }

    this.attempts.delete(clientKey);
    return timestamp;
  }

  async login(username: string, password: string, clientKey: string): Promise<AuthResult> {
    const timestamp = await this.authenticate(username, password, clientKey);
    this.prune(timestamp);
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
    const token = randomBytes(32).toString("base64url");
    const session: Session = {
      username: this.config.username,
      csrfToken: randomBytes(32).toString("base64url"),
      createdAt: timestamp,
      lastSeenAt: timestamp,
      expiresAt: timestamp + ABSOLUTE_TTL_MS,
    };
    this.sessions.set(hashToken(token), session);
    return { session, cookie: this.cookie(token, 43_200) };
  }

  async changePassword(currentPassword: string, newPassword: string, clientKey: string, persist: (hash: string) => Promise<void>): Promise<void> {
    const bytes = Buffer.byteLength(newPassword, "utf8");
    if (bytes < 12 || bytes > 1024) throw new HttpError(400, "New password must be 12-1024 UTF-8 bytes", "invalid_password");
    if (currentPassword === newPassword) throw new HttpError(400, "New password must differ from current password", "password_unchanged");
    await this.authenticate(this.config.username, currentPassword, clientKey);
    const hash = await hashPassword(newPassword);
    await persist(hash);
    this.config.passwordHash = hash;
    this.sessions.clear();
  }

  requireSession(request: IncomingMessage): Session {
    const timestamp = this.now();
    this.prune(timestamp);
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
    const session = token ? this.sessions.get(hashToken(token)) : undefined;
    if (
      !session ||
      timestamp >= session.expiresAt ||
      timestamp - session.lastSeenAt >= IDLE_TTL_MS
    ) {
      if (token) this.sessions.delete(hashToken(token));
      throw new HttpError(401, "Administrator session is required", "admin_unauthorized");
    }
    session.lastSeenAt = timestamp;
    return session;
  }

  requireMutation(request: IncomingMessage, session: Session): void {
    const csrf = Array.isArray(request.headers["x-csrf-token"])
      ? request.headers["x-csrf-token"][0]
      : request.headers["x-csrf-token"];
    if (!csrf || !equalText(csrf, session.csrfToken)) {
      throw new HttpError(403, "A valid CSRF token is required", "csrf_invalid");
    }
    this.requireSameOrigin(request);
  }

  requireLoginOrigin(request: IncomingMessage): void {
    this.requireSameOrigin(request);
  }

  private requireSameOrigin(request: IncomingMessage): void {
    const rawSecFetchSite = request.headers["sec-fetch-site"];
    const secFetchSite = Array.isArray(rawSecFetchSite) ? rawSecFetchSite[0] : rawSecFetchSite;
    if (secFetchSite === "cross-site") {
      throw new HttpError(403, "Cross-site administrator writes are forbidden", "origin_forbidden");
    }
    const rawOrigin = request.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    if (origin) {
      const rawHost = request.headers["x-forwarded-host"] ?? request.headers.host;
      const rawProto = request.headers["x-forwarded-proto"] ?? (this.config.cookieSecure ? "https" : "http");
      const host = (Array.isArray(rawHost) ? rawHost[0] : rawHost)?.split(",")[0]?.trim();
      const proto = (Array.isArray(rawProto) ? rawProto[0] : rawProto)?.split(",")[0]?.trim();
      let expected: string;
      try {
        expected = new URL(`${proto}://${host}`).origin;
      } catch {
        throw new HttpError(403, "Request origin could not be verified", "origin_forbidden");
      }
      if (origin !== expected) {
        throw new HttpError(403, "Request origin is not same-origin", "origin_forbidden");
      }
    } else {
      if (!secFetchSite || !["same-origin", "same-site", "none"].includes(secFetchSite)) {
        throw new HttpError(403, "Request site could not be verified", "origin_forbidden");
      }
    }
  }

  logout(request: IncomingMessage): string {
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (token) this.sessions.delete(hashToken(token));
    return this.cookie("", 0);
  }

  response(session: Session): Record<string, unknown> {
    return {
      authenticated: true,
      username: session.username,
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  private prune(timestamp: number): void {
    for (const [key, session] of this.sessions) {
      if (timestamp >= session.expiresAt || timestamp - session.lastSeenAt >= IDLE_TTL_MS) {
        this.sessions.delete(key);
      }
    }
  }

  private pruneAttempts(timestamp: number): void {
    for (const [key, attempt] of this.attempts) {
      attempt.failures = attempt.failures.filter(
        (failedAt) => failedAt > timestamp - 15 * 60 * 1_000,
      );
      if (attempt.failures.length === 0 && attempt.blockedUntil <= timestamp) {
        this.attempts.delete(key);
      }
    }
  }

  private cookie(value: string, maxAge: number): string {
    return [
      `${COOKIE_NAME}=${value}`,
      "Path=/api/v1/admin",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${maxAge}`,
      ...(this.config.cookieSecure ? ["Secure"] : []),
    ].join("; ");
  }
}
