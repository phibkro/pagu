// effects: Pi-native request tool bridged to the packaged request-only adapter.
import { spawn } from "node:child_process";

export interface PaguReadArguments {
  readonly path: string;
  readonly need: string;
  readonly justification: string;
}

export interface PiToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: { readonly decision: Record<string, unknown> };
}

export interface PiToolDefinition {
  readonly name: "request_read_access";
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  readonly parameters: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
  execute(
    toolCallId: string,
    params: PaguReadArguments,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: unknown,
  ): Promise<PiToolResult>;
}

export interface PiExtensionApi {
  registerTool(definition: PiToolDefinition): void;
}

export interface PaguMcpCommand {
  readonly command: string;
  readonly args?: readonly string[];
}

const SUBSTITUTED_MCP_COMMAND = "@PAGU_MCP_COMMAND@";
const PACKAGED_MCP_COMMAND = SUBSTITUTED_MCP_COMMAND.startsWith("@")
  ? "pagu-mcp"
  : SUBSTITUTED_MCP_COMMAND;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function object(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${at} must be an object`);
  }
  return value as Record<string, unknown>;
}

function textFromContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item) =>
      item !== null && typeof item === "object" &&
      (item as Record<string, unknown>).type === "text" &&
      typeof (item as Record<string, unknown>).text === "string"
    )
    .map((item) => (item as { text: string }).text)
    .join("\n") || undefined;
}

async function requestThroughMcp(
  mcp: PaguMcpCommand,
  params: PaguReadArguments,
  signal?: AbortSignal,
): Promise<PiToolResult> {
  if (signal?.aborted) {
    throw new DOMException("request cancelled", "AbortError");
  }
  const child = spawn(mcp.command, [...(mcp.args ?? [])], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let overflow: Error | undefined;
  const append = (current: string, chunk: unknown): string => {
    const next = current + String(chunk);
    if (next.length > MAX_OUTPUT_BYTES) {
      overflow = new Error("pagu request adapter exceeded its output bound");
      child.kill("SIGTERM");
    }
    return next;
  };
  child.stdout.on("data", (chunk) => stdout = append(stdout, chunk));
  child.stderr.on("data", (chunk) => stderr = append(stderr, chunk));
  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {} },
  };
  const call = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "request_read_access",
      arguments: params,
    },
  };
  child.stdin.end(`${JSON.stringify(initialize)}\n${JSON.stringify(call)}\n`);

  const status = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once(
      "close",
      (code, closedSignal) => resolve({ code, signal: closedSignal }),
    );
  }).finally(() => signal?.removeEventListener("abort", abort));

  if (signal?.aborted) {
    throw new DOMException("request cancelled", "AbortError");
  }
  if (overflow) throw overflow;
  if (status.code !== 0) {
    const detail = stderr.trim() || `signal ${status.signal ?? "unknown"}`;
    throw new Error(`pagu request adapter exited ${status.code}: ${detail}`);
  }

  let response: Record<string, unknown> | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const candidate = object(JSON.parse(line), "pagu MCP response");
    if (candidate.id === 2) response = candidate;
  }
  if (!response) {
    throw new Error("pagu request adapter returned no tool result");
  }
  if (response.error !== undefined) {
    const failure = object(response.error, "pagu MCP error");
    throw new Error(String(failure.message ?? "pagu request failed"));
  }
  const result = object(response.result, "pagu MCP result");
  if (result.isError === true) {
    throw new Error(textFromContent(result.content) ?? "pagu request failed");
  }
  if (
    result.structuredContent === null ||
    typeof result.structuredContent !== "object" ||
    Array.isArray(result.structuredContent)
  ) {
    throw new Error("pagu MCP result is missing structured decision");
  }
  const structured = result.structuredContent as Record<string, unknown>;
  if (
    structured.decision === null ||
    typeof structured.decision !== "object" ||
    Array.isArray(structured.decision)
  ) {
    throw new Error("pagu MCP result is missing structured decision");
  }
  const decision = structured.decision as Record<string, unknown>;
  return {
    content: [{
      type: "text",
      text: textFromContent(result.content) ?? JSON.stringify(decision),
    }],
    details: { decision },
  };
}

/** Build the Pi-native transport adapter without adding an adjudication path. */
export function createPaguExtension(
  mcp: PaguMcpCommand,
): (pi: PiExtensionApi) => void {
  return (pi) => {
    pi.registerTool({
      name: "request_read_access",
      label: "Request read access from the pagu host",
      description:
        "Request one exact read-only path after a denied read. The enclosing " +
        "pagu gate decides; approval may replace this process, after which " +
        "the resumed session retries the original read.",
      promptSnippet: "Request one exact read-only path from the pagu host",
      promptGuidelines: [
        "Use request_read_access only after an actual denied read, and retry " +
        "that read after the pagu session resumes.",
      ],
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Exact absolute, $PWD, $HOME, or ~ path; no wildcard or traversal.",
          },
          need: {
            type: "string",
            description: "The concrete information or artifact needed.",
          },
          justification: {
            type: "string",
            description: "Why the task requires reading that exact path.",
          },
        },
        required: ["path", "need", "justification"],
        additionalProperties: false,
      },
      execute: (_toolCallId, params, signal) =>
        requestThroughMcp(mcp, params, signal),
    });
  };
}

export default createPaguExtension({ command: PACKAGED_MCP_COMMAND });
