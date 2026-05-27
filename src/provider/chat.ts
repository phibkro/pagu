// effects: network (model HTTP) — dispatcher
/**
 * Provider client — the OpenAI **Chat Completions** wire format
 * (`POST {baseURL}/chat/completions`), the lingua franca that covers
 * Ollama (via its `/v1` endpoint), OpenRouter (→ 300+ models incl.
 * Anthropic/OpenAI), OpenAI, Groq, LM Studio, vLLM, … with one client.
 * Hand-rolled (no SDK) to stay minimal and offline-capable. BYO key via
 * the Authorization header; omit for local providers.
 */
import { chatAnthropic } from "./anthropic.ts";

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

/** Dispatch to the right wire format. The single entry point frontends use. */
export function chat(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
): Promise<ChatResponse> {
  return cfg.format === "anthropic"
    ? chatAnthropic(cfg, messages, tools)
    : chatOpenAI(cfg, messages, tools);
}

async function chatOpenAI(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
): Promise<ChatResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cfg.apiKey) headers["authorization"] = `Bearer ${cfg.apiKey}`;

  const body = {
    model: cfg.model,
    messages,
    stream: false,
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

  const url = `${cfg.baseURL.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`provider ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as OpenAIChatResponse;
  const msg = data.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => {
    let args: Record<string, unknown> = {};
    const raw = tc.function?.arguments;
    if (raw) {
      try {
        args = JSON.parse(raw);
      } catch {
        args = {}; // tolerate malformed tool args
      }
    }
    return { name: tc.function?.name ?? "", args };
  });
  return { content: msg.content ?? "", toolCalls };
}
