/**
 * Ollama provider client — a thin wrapper over the `/api/chat` HTTP API.
 * Deliberately minimal: pagu only ever offers `read` + `write` tools (no
 * exec), so this just shuttles messages + tool definitions and parses the
 * model's content + tool calls back out. Tested against a local HTTP mock
 * (the aimock pattern) rather than a live model.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
}

/** A tool exposed to the model (JSON-schema parameters). */
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

export interface OllamaOptions {
  model: string;
  /** Defaults to the local Ollama. Point at a mock server in tests. */
  baseUrl?: string;
}

/** Shape of the bits of `/api/chat` (non-streamed) we consume. */
interface OllamaChatResponse {
  message?: {
    content?: string;
    tool_calls?: Array<
      { function?: { name?: string; arguments?: Record<string, unknown> } }
    >;
  };
}

export async function chat(
  opts: OllamaOptions,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
): Promise<ChatResponse> {
  const baseUrl = opts.baseUrl ?? "http://localhost:11434";
  const body = {
    model: opts.model,
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
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`ollama ${res.status}: ${await res.text()}`);
  }
  const data = await res.json() as OllamaChatResponse;
  const msg = data.message ?? {};
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
    name: tc.function?.name ?? "",
    args: tc.function?.arguments ?? {},
  }));
  return { content: msg.content ?? "", toolCalls };
}
