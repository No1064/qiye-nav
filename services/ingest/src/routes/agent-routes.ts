import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "../errors.js";
import { parseNavAgentInput, type NavAgent } from "../nav-agent.js";

interface Context {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  corsHeaders: Record<string, string>;
  ingestToken: string;
  agent?: NavAgent;
  requireAuth: (request: IncomingMessage, expected: string) => void;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  json: (response: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
}

function isSameOrigin(request: IncomingMessage): boolean {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : "";
  const host = typeof request.headers["x-forwarded-host"] === "string" ? request.headers["x-forwarded-host"] : request.headers.host;
  if (!origin || !host) return false;
  try { return new URL(origin).host === host && request.headers["sec-fetch-site"] !== "cross-site"; } catch { return false; }
}

export async function handleAgentRoutes(context: Context): Promise<boolean> {
  const { request, response, url, corsHeaders, ingestToken, agent, requireAuth, readJson, json } = context;
  if (url.pathname !== "/api/v1/agent/query") return false;
  if (request.method !== "POST") throw new HttpError(405, "Navigation agent only supports POST", "method_not_allowed");
  if (!agent) throw new HttpError(503, "Navigation agent is unavailable", "ai_unavailable");
  if (!isSameOrigin(request)) requireAuth(request, ingestToken);
  json(response, 200, await agent.query(parseNavAgentInput(await readJson(request))), {
    ...corsHeaders,
    "cache-control": "no-store",
  });
  return true;
}
