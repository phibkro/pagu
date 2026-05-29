// effects: network (model HTTP) — dispatcher
/**
 * Provider client — the OpenAI **Chat Completions** wire format
 * (`POST {baseURL}/chat/completions`), the lingua franca that covers
 * Ollama (via its `/v1` endpoint), OpenRouter (→ 300+ models incl.
 * Anthropic/OpenAI), OpenAI, Groq, LM Studio, vLLM, … with one client.
 * Hand-rolled (no SDK) to stay minimal and offline-capable. BYO key via
 * the Authorization header; omit for local providers.
 */
import { TextLineStream } from "@std/streams";
import { chatAnthropic, fetchModelsAnthropic } from "./anthropic.ts";
import { makeThinkSplitter } from "./think.ts";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
}

export interface ProviderConfig {
  model: string;
  /** API root ending at the version prefix, e.g. `https://.../v1`. */
  baseURL: string;
  /** Bearer token (resolved from an env var by the caller). Optional for local. */
  apiKey?: string;
  /** Wire format: OpenAI Chat Completions (default) or Anthropic Messages. */
  format?: "openai" | "anthropic";
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      // Chat Completions returns tool-call arguments as a JSON *string*.
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

/** Called with each content token as it streams in (display side-channel). */
export type TokenSink = (token: string) => void;

/**
 * Build a one-line error from a non-OK provider response: extract the API's
 * `error.message` when the body is JSON (the readable part), else truncate
 * the raw body. Keeps a 401/404/billing error from becoming a stack dump.
 */
export async function providerError(
  name: string,
  res: Response,
): Promise<Error> {
  const body = await res.text();
  let msg = body;
  try {
    const j = JSON.parse(body) as { error?: { message?: string } };
    msg = j?.error?.message ?? body;
  } catch { /* not JSON — keep the raw body */ }
  return new Error(`${name} ${res.status}: ${msg.slice(0, 300)}`);
}

/**
 * Dispatch to the right wire format. The single entry point frontends use.
 * Pass `onToken` to stream content tokens as they arrive (OpenAI format
 * only; Anthropic stays buffered for now). The returned ChatResponse is
 * identical either way — streaming is purely a display affordance.
 */
export function chat(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  onToken?: TokenSink,
  onReasoning?: TokenSink,
): Promise<ChatResponse> {
  return cfg.format === "anthropic"
    ? chatAnthropic(cfg, messages, tools)
    : chatOpenAI(cfg, messages, tools, onToken, onReasoning);
}

/** List the provider's available model ids. OpenAI-compat: `GET
 * {baseURL}/models`; Anthropic: `GET {baseURL}/v1/models`. Both return
 * `{ data: [{ id }] }`. Effectful (one GET); the orchestrator never calls this
 * directly — it runs in a net-scoped subprocess (`phases/models.ts`). */
export function fetchModels(cfg: ProviderConfig): Promise<string[]> {
  return cfg.format === "anthropic"
    ? fetchModelsAnthropic(cfg)
    : fetchModelsOpenAI(cfg);
}

async function fetchModelsOpenAI(cfg: ProviderConfig): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers["authorization"] = `Bearer ${cfg.apiKey}`;
  const res = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/models`, {
    headers,
  });
  if (!res.ok) {
    throw new Error(`models request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json() as { data?: { id: string }[] };
  return (json.data ?? []).map((m) => m.id);
}

/** Shared request shape for both the buffered and streaming paths. */
function openAIRequest(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  stream: boolean,
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cfg.apiKey) headers["authorization"] = `Bearer ${cfg.apiKey}`;
  const body = {
    model: cfg.model,
    messages,
    stream,
    tools: tools.length > 0
      ? tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
      : undefined,
  };
  return {
    url: `${cfg.baseURL.replace(/\/$/, "")}/chat/completions`,
    init: { method: "POST", headers, body: JSON.stringify(body) },
  };
}

/** Finalize accumulated tool-call argument strings into parsed ToolCalls. */
function toToolCalls(
  raw: Array<{ name: string; args: string }>,
): ToolCall[] {
  return raw.map((tc) => {
    let args: Record<string, unknown> = {};
    if (tc.args) {
      try {
        args = JSON.parse(tc.args);
      } catch {
        args = {}; // tolerate malformed tool args
      }
    }
    return { name: tc.name, args };
  });
}

async function chatOpenAI(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  onToken?: TokenSink,
  onReasoning?: TokenSink,
): Promise<ChatResponse> {
  const { url, init } = openAIRequest(cfg, messages, tools, !!onToken);
  const res = await fetch(url, init);
  if (!res.ok) {
    throw await providerError("provider", res);
  }
  return onToken && res.body
    ? parseStream(res.body, onToken, onReasoning)
    : parseBuffered(await res.json() as OpenAIChatResponse);
}

function parseBuffered(data: OpenAIChatResponse): ChatResponse {
  const msg = data.choices?.[0]?.message ?? {};
  // Strip <think> from buffered content (reasoning dropped — no live sink).
  const splitter = makeThinkSplitter();
  const seg = splitter.feed(msg.content ?? "");
  const f = splitter.flush();
  const toolCalls = toToolCalls(
    (msg.tool_calls ?? []).map((tc) => ({
      name: tc.function?.name ?? "",
      args: tc.function?.arguments ?? "",
    })),
  );
  return { content: seg.content + f.content, toolCalls };
}

interface StreamChoice {
  delta?: {
    content?: string | null;
    tool_calls?: Array<
      { index?: number; function?: { name?: string; arguments?: string } }
    >;
  };
}

/**
 * Parse a Server-Sent-Events `chat/completions` stream. Content deltas are
 * accumulated AND forwarded to `onToken` live; tool-call fragments are
 * reassembled per index (name arrives once, `arguments` arrives in pieces).
 */
async function parseStream(
  body: ReadableStream<Uint8Array>,
  onToken: TokenSink,
  onReasoning?: TokenSink,
): Promise<ChatResponse> {
  let content = "";
  const calls = new Map<number, { name: string; args: string }>();
  // Split <think> reasoning out of the content stream (live, ephemeral): it
  // streams via onReasoning and never enters `content` (the persisted answer).
  const think = makeThinkSplitter();
  const route = (seg: { content: string; reasoning: string }) => {
    if (seg.content) {
      content += seg.content;
      onToken(seg.content);
    }
    if (seg.reasoning) onReasoning?.(seg.reasoning);
  };

  // TextLineStream handles the cross-chunk line buffering; we only parse
  // SSE semantics (the `data:` prefix and the `[DONE]` sentinel) on top.
  const lines = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());
  for await (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let choice: StreamChoice;
    try {
      choice = (JSON.parse(payload).choices?.[0] ?? {}) as StreamChoice;
    } catch {
      continue; // tolerate keep-alive / malformed lines
    }
    const delta = choice.delta;
    if (!delta) continue;
    if (typeof delta.content === "string" && delta.content) {
      route(think.feed(delta.content));
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = calls.get(idx) ?? { name: "", args: "" };
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(idx, cur);
    }
  }
  route(think.flush()); // surface any buffered partial-tag text
  return { content, toolCalls: toToolCalls([...calls.values()]) };
}
