// effects: network (model HTTP)
import { TextLineStream } from "@std/streams";
import {
  type ChatMessage,
  type ChatResponse,
  type ProviderConfig,
  providerError,
  type TokenSink,
  type ToolCall,
  type ToolDef,
  type Usage,
} from "./chat.ts";

/**
 * Native Anthropic Messages API client (`POST {baseURL}/v1/messages`).
 * Translates pagu's OpenAI-shaped messages/tools to Anthropic's format:
 * `system` is a top-level param (not a message); only user/assistant
 * roles exist (our `tool` context becomes `user`); consecutive same-role
 * turns are coalesced; tools use `input_schema`; tool calls come back as
 * `tool_use` content blocks (args are an object, not a JSON string).
 * Auth is `x-api-key` + `anthropic-version`, not a Bearer token.
 */

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

/** List Anthropic model ids — `GET {baseURL}/v1/models`, `{ data: [{ id }] }`,
 * auth via `x-api-key` + `anthropic-version` (not Bearer). */
export async function fetchModelsAnthropic(
  cfg: ProviderConfig,
): Promise<string[]> {
  const headers: Record<string, string> = {
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;
  const res = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/v1/models`, {
    headers,
  });
  if (!res.ok) throw await providerError("anthropic", res);
  const json = await res.json() as { data?: { id: string }[] };
  return (json.data ?? []).map((m) => m.id);
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicResponse {
  content?: Array<
    | { type: "text"; text: string }
    | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
    | { type: string }
  >;
  usage?: AnthropicUsage;
  // "max_tokens" → cut off by the output cap; "end_turn"/"tool_use"/… → normal.
  stop_reason?: string | null;
}

/** Map an Anthropic `usage` object to our Usage (cache fields when present). */
function mapAnthropicUsage(u: AnthropicUsage | undefined): Usage | undefined {
  if (!u) return undefined;
  const usage: Usage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
  };
  if (u.cache_read_input_tokens !== undefined) {
    usage.cacheReadTokens = u.cache_read_input_tokens;
  }
  if (u.cache_creation_input_tokens !== undefined) {
    usage.cacheCreationTokens = u.cache_creation_input_tokens;
  }
  return usage;
}

export async function chatAnthropic(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  onToken?: TokenSink,
  onReasoning?: TokenSink,
): Promise<ChatResponse> {
  const systemParts: string[] = [];
  const coalesced: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user"; // tool -> user
    const last = coalesced.at(-1);
    if (last && last.role === role) last.content += `\n\n${m.content}`;
    else coalesced.push({ role, content: m.content });
  }
  // Anthropic requires the first message to be `user`.
  if (coalesced[0]?.role === "assistant") {
    coalesced.unshift({ role: "user", content: "(continue)" });
  }

  // Second cache breakpoint: cache the growing *message* prefix (the first
  // breakpoint, on `system` below, caches the stable tools+system prefix).
  // Anthropic caches the prefix up to and including the block carrying
  // `cache_control`, so marking the LAST (coalesced) turn caches the whole
  // conversation-so-far; the next turn reads it as a prefix hit and writes a
  // fresh breakpoint at its new last turn (incremental caching). One marker, so
  // we stay well within the 4-breakpoint budget (system uses 1). A no-op below
  // the model's min cacheable size — same always-on rationale as system.
  // Marking only the last turn keeps earlier turns plain strings (they can't
  // write distinct per-turn entries — they're read as part of the cached prefix).
  // Placed AFTER coalescing + the assistant-first fixup so it lands on the turn
  // actually sent, and so an injected "(continue)" turn is still cache-eligible.
  const turns: Array<{
    role: "user" | "assistant";
    content:
      | string
      | Array<
        { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
      >;
  }> = [...coalesced];
  const last = turns.at(-1);
  if (last) {
    turns[turns.length - 1] = {
      role: last.role,
      content: [
        {
          type: "text",
          text: last.content as string,
          cache_control: { type: "ephemeral" },
        },
      ],
    };
  }

  const stream = !!onToken;
  // System as a structured text block with a cache breakpoint. Tools precede
  // system in the prompt prefix, so this breakpoint caches the entire stable
  // `tools + system` prefix (the AGENTS.md instructions + tool defs that pagu
  // re-sends verbatim every turn) — later turns read it at ~0.1x input cost.
  // A no-op (no error) when the prefix is below the model's min cacheable size.
  // The growing message prefix gets its own breakpoint (on the last turn, above).
  // GA, no beta header.
  const systemText = systemParts.join("\n\n");
  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens ?? MAX_TOKENS,
    ...(systemText
      ? {
        system: [
          {
            type: "text",
            text: systemText,
            cache_control: { type: "ephemeral" },
          },
        ],
      }
      : {}),
    messages: turns,
    ...(stream ? { stream: true } : {}),
    ...(tools.length > 0
      ? {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      }
      : {}),
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;

  const res = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await providerError("anthropic", res);

  return stream && res.body
    ? streamAnthropic(res.body, onToken!, onReasoning)
    : parseBuffered(await res.json() as AnthropicResponse);
}

/** Parse a buffered (non-streaming) Messages response. */
function parseBuffered(data: AnthropicResponse): ChatResponse {
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text") content += (block as { text: string }).text;
    else if (block.type === "tool_use") {
      const b = block as { name: string; input?: Record<string, unknown> };
      toolCalls.push({ name: b.name, args: b.input ?? {} });
    }
  }
  return {
    content,
    toolCalls,
    usage: mapAnthropicUsage(data.usage),
    ...(data.stop_reason === "max_tokens" ? { truncated: true } : {}),
  };
}

interface StreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    // On `message_delta`: "max_tokens" = cut off by the output cap.
    stop_reason?: string | null;
  };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

/**
 * Parse Anthropic's Messages SSE stream. Text streams as `text_delta` (live →
 * `onToken`, accumulated into `content`); a tool call's name arrives in
 * `content_block_start` and its input streams as `input_json_delta` fragments
 * reassembled per index then JSON-parsed; `thinking_delta` (extended thinking)
 * is routed to `onReasoning` and never enters `content` (ephemeral display).
 * `event:` lines are ignored — the `type` field inside each `data:` JSON is
 * the discriminator.
 */
async function streamAnthropic(
  body: ReadableStream<Uint8Array>,
  onToken: TokenSink,
  onReasoning?: TokenSink,
): Promise<ChatResponse> {
  let content = "";
  let truncated = false;
  // Usage accrues across the stream: message_start carries input + cache
  // tokens; message_delta carries the (cumulative) final output_tokens.
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  // tool_use blocks by content-block index: name + accumulated input JSON.
  const tools = new Map<number, { name: string; args: string }>();
  const lines = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());
  for await (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue; // skip `event:` + blank lines
    const payload = line.slice(5).trim();
    if (!payload) continue;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(payload) as StreamEvent;
    } catch {
      continue; // tolerate keep-alive / malformed lines
    }
    if (ev.type === "error") {
      // An in-stream error (e.g. overloaded_error / 529 mid-stream) — surface it
      // as a clean throw, same shape as a non-OK HTTP response.
      throw new Error(
        `anthropic stream: ${ev.error?.message ?? ev.error?.type ?? "error"}`,
      );
    }
    if (ev.type === "message_start") {
      const u = mapAnthropicUsage(ev.message?.usage);
      if (u) {
        usage.inputTokens = u.inputTokens;
        if (u.cacheReadTokens !== undefined) {
          usage.cacheReadTokens = u.cacheReadTokens;
        }
        if (u.cacheCreationTokens !== undefined) {
          usage.cacheCreationTokens = u.cacheCreationTokens;
        }
      }
    } else if (ev.type === "message_delta") {
      if (ev.usage?.output_tokens !== undefined) {
        usage.outputTokens = ev.usage.output_tokens; // cumulative final count
      }
      if (ev.delta?.stop_reason === "max_tokens") truncated = true;
    }
    if (ev.type === "content_block_start") {
      const cb = ev.content_block;
      if (cb?.type === "tool_use") {
        tools.set(ev.index ?? 0, { name: cb.name ?? "", args: "" });
      }
    } else if (ev.type === "content_block_delta") {
      const d = ev.delta ?? {};
      if (d.type === "text_delta" && d.text) {
        content += d.text;
        onToken(d.text);
      } else if (d.type === "input_json_delta" && d.partial_json) {
        const t = tools.get(ev.index ?? 0);
        if (t) t.args += d.partial_json;
      } else if (d.type === "thinking_delta" && d.thinking) {
        onReasoning?.(d.thinking);
      }
    }
  }
  const toolCalls: ToolCall[] = [...tools.values()].map((t) => {
    let args: Record<string, unknown> = {};
    if (t.args) {
      try {
        args = JSON.parse(t.args);
      } catch {
        args = {}; // tolerate malformed tool args
      }
    }
    return { name: t.name, args };
  });
  return {
    content,
    toolCalls,
    usage,
    ...(truncated ? { truncated: true } : {}),
  };
}
