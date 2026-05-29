// effects: network (model HTTP)
import {
  type ChatMessage,
  type ChatResponse,
  type ProviderConfig,
  providerError,
  type ToolCall,
  type ToolDef,
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
}

export async function chatAnthropic(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
): Promise<ChatResponse> {
  const systemParts: string[] = [];
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user"; // tool -> user
    const last = turns.at(-1);
    if (last && last.role === role) last.content += `\n\n${m.content}`;
    else turns.push({ role, content: m.content });
  }
  // Anthropic requires the first message to be `user`.
  if (turns[0]?.role === "assistant") {
    turns.unshift({ role: "user", content: "(continue)" });
  }

  const body = {
    model: cfg.model,
    max_tokens: MAX_TOKENS,
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    messages: turns,
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

  const data = await res.json() as AnthropicResponse;
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text") content += (block as { text: string }).text;
    else if (block.type === "tool_use") {
      const b = block as { name: string; input?: Record<string, unknown> };
      toolCalls.push({ name: b.name, args: b.input ?? {} });
    }
  }
  return { content, toolCalls };
}
