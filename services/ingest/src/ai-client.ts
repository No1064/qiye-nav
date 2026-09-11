import { HttpError } from "./errors.js";
import { assertPublicFetchUrl } from "./security.js";
import type { AiConfigRecord } from "./types.js";
import type { AiUsage } from "./types.js";

const MAX_AI_RESPONSE_BYTES = 1024 * 1024;

export interface AiClientOptions {
  fetchImpl?: typeof fetch;
  assertUrl?: (url: URL) => Promise<void>;
  timeoutMs?: number;
}

export interface AiCompletion {
  content: string;
  model: string;
  finishReason?: string;
  usage?: AiUsage;
  latencyMs: number;
}

export class AiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly assertUrl: (url: URL) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: AiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.assertUrl = options.assertUrl ?? assertPublicFetchUrl;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async test(config: AiConfigRecord): Promise<{ ok: true; model: string; latencyMs: number }> {
    const started = Date.now();
    let content = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        content = await this.complete(
          config,
          'Return only a valid JSON object with this exact shape: {"ok":true}',
          256,
        );
        break;
      } catch (error) {
        if (!(error instanceof HttpError) || error.code !== "ai_empty_completion" || attempt > 0) throw error;
      }
    }
    try {
      const parsed = JSON.parse(content) as { ok?: unknown };
      if (parsed.ok !== true) throw new Error("unexpected result");
    } catch {
      throw new HttpError(502, "AI provider test returned invalid JSON", "ai_invalid_response");
    }
    return { ok: true, model: config.model, latencyMs: Date.now() - started };
  }

  async complete(config: AiConfigRecord, prompt: string, maxTokens = 4_096): Promise<string> {
    return (await this.completeDetailed(config, prompt, maxTokens)).content;
  }

  async completeDetailed(
    config: AiConfigRecord,
    prompt: string,
    maxTokens = 4_096,
    timeoutMs = this.timeoutMs,
  ): Promise<AiCompletion> {
    const endpoint = new URL(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`);
    await this.assertUrl(endpoint);
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let timeoutStage: "request" | "response_body" = "request";
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.1,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }],
          ...(config.provider === "deepseek" ? { thinking: { type: "disabled" } } : {}),
        }),
      });
      timeoutStage = "response_body";
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new HttpError(422, "AI provider rejected the API key", "ai_auth_failed");
      }
      if (response.status === 429) {
        await response.body?.cancel();
        throw new HttpError(429, "AI provider rate limit exceeded", "ai_rate_limited", {
          retryAfterSeconds: Number(response.headers.get("retry-after")) || 1,
          upstreamStatus: response.status,
          providerRequestId: requestId(response),
        });
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        throw new HttpError(502, "AI provider is temporarily unavailable", "ai_upstream_unavailable", {
          upstreamStatus: response.status,
          providerRequestId: requestId(response),
        });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpError(422, `AI provider returned HTTP ${response.status}`, "ai_request_failed", {
          upstreamStatus: response.status,
          providerRequestId: requestId(response),
        });
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json")) {
        await response.body?.cancel();
        throw new HttpError(502, "AI provider did not return JSON", "ai_invalid_response");
      }
      let rawText: string;
      try {
        rawText = await readLimitedText(response, MAX_AI_RESPONSE_BYTES);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if ((error as Error).name === "AbortError") throw error;
        throw new HttpError(502, "AI provider response could not be read", "ai_request_failed");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawText);
      } catch {
        throw new HttpError(502, "AI provider returned invalid JSON", "ai_invalid_response");
      }
      const result = extractCompletion(payload, config.model);
      const content = result.content;
      if (Buffer.byteLength(content, "utf8") > MAX_AI_RESPONSE_BYTES) {
        throw new HttpError(502, "AI response is too large", "ai_response_too_large");
      }
      return { ...result, latencyMs: Date.now() - started };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if ((error as Error).name === "AbortError") {
        const stageLabel = timeoutStage === "request" ? "waiting for response" : "reading response body";
        throw new HttpError(504, `AI provider request timed out after ${Math.round(timeoutMs / 1_000)} seconds while ${stageLabel}`, "ai_timeout", {
          timeoutMs, stage: timeoutStage,
        });
      }
      throw new HttpError(502, "AI provider request failed", "ai_request_failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function requestId(response: Response): string | undefined {
  return response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
}

async function readLimitedText(response: Response, maximum: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new HttpError(502, "AI response is too large", "ai_response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new HttpError(502, "AI response is too large", "ai_response_too_large");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function extractCompletion(value: unknown, fallbackModel: string): Omit<AiCompletion, "latencyMs"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(502, "AI provider returned an invalid response", "ai_invalid_response");
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    throw new HttpError(502, "AI provider returned no completion", "ai_invalid_response");
  }
  const choice = choices[0] as { message?: unknown; finish_reason?: unknown };
  const message = choice.message;
  const content = message && typeof message === "object"
    ? (message as { content?: unknown }).content
    : undefined;
  if (typeof content !== "string" || !content.trim()) {
    if (choice.finish_reason === "length") {
      throw new HttpError(502, "AI provider output was truncated", "ai_response_truncated");
    }
    throw new HttpError(502, "AI provider returned an empty completion", "ai_empty_completion");
  }
  const raw = value as { model?: unknown; usage?: unknown };
  const result: Omit<AiCompletion, "latencyMs"> = {
    content: content.trim(),
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : fallbackModel,
  };
  if (typeof choice.finish_reason === "string") result.finishReason = choice.finish_reason;
  const usage = parseUsage(raw.usage);
  if (usage) result.usage = usage;
  return result;
}

function parseUsage(value: unknown): AiUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const usage: AiUsage = {};
  if (Number.isInteger(raw.prompt_tokens) && (raw.prompt_tokens as number) >= 0) {
    usage.promptTokens = raw.prompt_tokens as number;
  }
  if (Number.isInteger(raw.completion_tokens) && (raw.completion_tokens as number) >= 0) {
    usage.completionTokens = raw.completion_tokens as number;
  }
  if (Number.isInteger(raw.total_tokens) && (raw.total_tokens as number) >= 0) {
    usage.totalTokens = raw.total_tokens as number;
  }
  return Object.keys(usage).length ? usage : undefined;
}

export function isRetryableAiError(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  const status = (error.details as { upstreamStatus?: unknown } | undefined)?.upstreamStatus;
  return error.code === "ai_rate_limited" || error.code === "ai_empty_completion" ||
    (typeof status === "number" && status >= 500);
}
