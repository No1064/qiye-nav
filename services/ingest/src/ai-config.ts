import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { HttpError } from "./errors.js";
import type { AiConfigPublic, AiConfigRecord, AiProvider } from "./types.js";

const AAD = Buffer.from("personal-nav-ai-config-v1", "utf8");
const PRESETS: Record<AiProvider, Pick<AiConfigRecord, "baseUrl" | "model">> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
};
export const DEFAULT_AGENT_CONFIG = Object.freeze({
  agentName: "栖页导航助手",
  agentRolePrompt: "你是栖页的导航助手，帮助用户从个人导航目录中找到合适的入口。",
  agentCapabilityPrompt: "使用简洁、自然的中文回答；信息不足时明确说明，并优先给出最相关的目录条目。",
});

interface EncryptedDocument {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface AiConfigPatch {
  provider: AiProvider;
  baseUrl?: string;
  model?: string;
  apiKey?: string | null;
  agentName?: string;
  agentRolePrompt?: string;
  agentCapabilityPrompt?: string;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object", "invalid_request");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new HttpError(400, `${field} must be 1-${maximum} characters`, "invalid_request");
  }
  return value.trim();
}

export function parseAiConfigPatch(value: unknown): AiConfigPatch {
  const input = objectValue(value);
  if (input.provider !== "openai" && input.provider !== "deepseek") {
    throw new HttpError(400, "provider must be openai or deepseek", "invalid_request");
  }
  const baseUrl = input.baseUrl === undefined ? undefined : validateAiBaseUrl(text(input.baseUrl, "baseUrl", 2_048));
  const model = input.model === undefined ? undefined : text(input.model, "model", 200);
  let apiKey: string | null | undefined;
  if (input.apiKey === null) apiKey = null;
  else if (input.apiKey !== undefined) apiKey = text(input.apiKey, "apiKey", 4_096);
  const agentName = input.agentName === undefined ? undefined : text(input.agentName, "agentName", 80);
  const agentRolePrompt = input.agentRolePrompt === undefined
    ? undefined : text(input.agentRolePrompt, "agentRolePrompt", 2_000);
  const agentCapabilityPrompt = input.agentCapabilityPrompt === undefined
    ? undefined : text(input.agentCapabilityPrompt, "agentCapabilityPrompt", 2_000);
  return {
    provider: input.provider,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(agentName ? { agentName } : {}),
    ...(agentRolePrompt ? { agentRolePrompt } : {}),
    ...(agentCapabilityPrompt ? { agentCapabilityPrompt } : {}),
  };
}

export function validateAiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "baseUrl must be a valid HTTPS URL", "invalid_ai_base_url");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new HttpError(
      400,
      "baseUrl must be HTTPS and must not contain credentials, query, or fragment",
      "invalid_ai_base_url",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function validateRecord(value: unknown): AiConfigRecord {
  const input = objectValue(value);
  if (input.provider !== "openai" && input.provider !== "deepseek") throw new Error("invalid provider");
  if (typeof input.baseUrl !== "string" || typeof input.model !== "string" || typeof input.apiKey !== "string") {
    throw new Error("invalid AI configuration fields");
  }
  return {
    provider: input.provider,
    baseUrl: validateAiBaseUrl(input.baseUrl),
    model: text(input.model, "model", 200),
    apiKey: input.apiKey,
    agentName: input.agentName === undefined
      ? DEFAULT_AGENT_CONFIG.agentName : text(input.agentName, "agentName", 80),
    agentRolePrompt: input.agentRolePrompt === undefined
      ? DEFAULT_AGENT_CONFIG.agentRolePrompt : text(input.agentRolePrompt, "agentRolePrompt", 2_000),
    agentCapabilityPrompt: input.agentCapabilityPrompt === undefined
      ? DEFAULT_AGENT_CONFIG.agentCapabilityPrompt : text(input.agentCapabilityPrompt, "agentCapabilityPrompt", 2_000),
  };
}

export class AiConfigStore {
  private readonly path: string;

  constructor(path: string, private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("AI encryption key must contain exactly 32 bytes");
    this.path = resolve(path);
  }

  async initialize(): Promise<void> {
    try {
      await this.read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  async publicConfig(): Promise<AiConfigPublic> {
    let record: AiConfigRecord | undefined;
    try {
      record = await this.read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const provider = record?.provider ?? "deepseek";
    const preset = PRESETS[provider];
    return {
      configured: !!record?.apiKey,
      provider,
      baseUrl: record?.baseUrl ?? preset.baseUrl,
      model: record?.model ?? preset.model,
      hasApiKey: !!record?.apiKey,
      agentName: record?.agentName ?? DEFAULT_AGENT_CONFIG.agentName,
      agentRolePrompt: record?.agentRolePrompt ?? DEFAULT_AGENT_CONFIG.agentRolePrompt,
      agentCapabilityPrompt: record?.agentCapabilityPrompt ?? DEFAULT_AGENT_CONFIG.agentCapabilityPrompt,
    };
  }

  async requireConfig(): Promise<AiConfigRecord> {
    try {
      const record = await this.read();
      if (!record.apiKey) throw new HttpError(409, "AI API key is not configured", "ai_not_configured");
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HttpError(409, "AI is not configured", "ai_not_configured");
      }
      throw error;
    }
  }

  async update(patch: AiConfigPatch): Promise<AiConfigPublic> {
    let current: AiConfigRecord | undefined;
    try {
      current = await this.read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const preset = PRESETS[patch.provider];
    const record: AiConfigRecord = {
      provider: patch.provider,
      baseUrl: patch.baseUrl ?? (current?.provider === patch.provider ? current.baseUrl : preset.baseUrl),
      model: patch.model ?? (current?.provider === patch.provider ? current.model : preset.model),
      apiKey: patch.apiKey === null ? "" : patch.apiKey ?? current?.apiKey ?? "",
      agentName: patch.agentName ?? current?.agentName ?? DEFAULT_AGENT_CONFIG.agentName,
      agentRolePrompt: patch.agentRolePrompt ?? current?.agentRolePrompt ?? DEFAULT_AGENT_CONFIG.agentRolePrompt,
      agentCapabilityPrompt: patch.agentCapabilityPrompt
        ?? current?.agentCapabilityPrompt
        ?? DEFAULT_AGENT_CONFIG.agentCapabilityPrompt,
    };
    await this.write(record);
    return this.publicConfig();
  }

  private async read(): Promise<AiConfigRecord> {
    try {
      const document = JSON.parse(await readFile(this.path, "utf8")) as EncryptedDocument;
      if (
        document.version !== 1 || document.algorithm !== "aes-256-gcm" ||
        typeof document.iv !== "string" || typeof document.tag !== "string" ||
        typeof document.ciphertext !== "string"
      ) throw new Error("invalid encrypted document");
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(document.iv, "base64"));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(document.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(document.ciphertext, "base64")), decipher.final(),
      ]);
      return validateRecord(JSON.parse(plaintext.toString("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      throw new HttpError(500, "Encrypted AI configuration is corrupt", "ai_config_corrupt");
    }
  }

  private async write(record: AiConfigRecord): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(record), "utf8"), cipher.final(),
    ]);
    const document: EncryptedDocument = {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    await atomicWrite(this.path, `${JSON.stringify(document, null, 2)}\n`);
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
