import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT_N = 16_384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LENGTH = 32;
const MAX_PASSWORD_BYTES = 1_024;

function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function validPassword(password: string): void {
  const length = Buffer.byteLength(password, "utf8");
  if (length < 12 || length > MAX_PASSWORD_BYTES) {
    throw new Error("Password must be 12-1024 UTF-8 bytes");
  }
}

export async function hashPassword(password: string): Promise<string> {
  validPassword(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    DEFAULT_N,
    DEFAULT_R,
    DEFAULT_P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export function parsePasswordHash(encoded: string): {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
} {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") throw new Error("Unsupported password hash format");
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (
    !Number.isInteger(N) || N < 16_384 || N > 1_048_576 || (N & (N - 1)) !== 0 ||
    !Number.isInteger(r) || r < 1 || r > 32 ||
    !Number.isInteger(p) || p < 1 || p > 16
  ) {
    throw new Error("Password hash has unsafe scrypt parameters");
  }
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length < 16 || expected.length !== KEY_LENGTH) throw new Error("Password hash payload is invalid");
  return { N, r, p, salt, expected };
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return false;
  const { N, r, p, salt, expected } = parsePasswordHash(encoded);
  const actual = await scrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: Math.max(64 * 1024 * 1024, 128 * N * r + 1024 * 1024),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readPassword(args: string[]): Promise<string> {
  if (args.length > 1) throw new Error("Usage: password.js hash [password]");
  if (args[0] !== undefined) return args[0];
  if (process.stdin.isTTY) throw new Error("Pass a password argument or pipe it on stdin");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
}

async function runCli(args: string[]): Promise<void> {
  if (args[0] !== "hash") throw new Error("Usage: password.js hash [password]");
  console.info(await hashPassword(await readPassword(args.slice(1))));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
