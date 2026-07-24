// pure: MCP session/tool schema; effects: stdio adapter and gate request client.
import {
  fileRequest,
  type FileRequestInput,
  type GateDecision,
  parseRequestInput,
} from "../request/index.ts";

export type PaguMcpMessage = {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

export type PaguMcpResponse =
  | {
    readonly jsonrpc: "2.0";
    readonly id: string | number;
    readonly result: Record<string, unknown>;
  }
  | {
    readonly jsonrpc: "2.0";
    readonly id: string | number | null;
    readonly error: {
      readonly code: number;
      readonly message: string;
    };
  };

export interface PaguMcpSession {
  handle(message: unknown): Promise<PaguMcpResponse | null>;
}

export type PaguReadRequest = (
  input: FileRequestInput,
) => Promise<GateDecision>;

const SUPPORTED_PROTOCOLS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);
const LATEST_PROTOCOL = "2025-11-25";

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "deny"] },
    scope: {
      anyOf: [
        { type: "string", enum: ["once", "session", "persist"] },
        { type: "null" },
      ],
    },
    tier: { type: "string", enum: ["refuse", "auto", "operator"] },
    rationale: { type: "string" },
    granted_rule: {
      type: "object",
      properties: { "fs.ro": { type: "string" } },
      required: ["fs.ro"],
      additionalProperties: false,
    },
  },
  required: ["verdict", "scope", "tier", "rationale"],
  additionalProperties: false,
} as const;

export const PAGU_MCP_TOOL = {
  name: "request_read_access",
  title: "Request read access from the pagu host",
  description:
    "Request one exact read-only filesystem path after a sandbox denial. " +
    "The enclosing gate may refuse, auto-approve, or ask the human host. " +
    "Approval replaces the sandbox, so this call may disconnect; after pagu " +
    "resumes the session, retry the original read.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Exact absolute, $PWD, $HOME, or ~ path; no wildcards or traversal.",
      },
      need: {
        type: "string",
        description: "The concrete information or artifact needed.",
      },
      justification: {
        type: "string",
        description: "Why this task requires reading that exact path.",
      },
    },
    required: ["path", "need", "justification"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { decision: DECISION_SCHEMA },
    required: ["decision"],
    additionalProperties: false,
  },
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;

function response(
  id: string | number,
  result: Record<string, unknown>,
): PaguMcpResponse {
  return { jsonrpc: "2.0", id, result };
}

function error(
  id: string | number | null,
  code: number,
  message: string,
): PaguMcpResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function object(
  value: unknown,
  at: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${at}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  at: string,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${at}: unknown key "${key}"`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${at}: missing key "${key}"`);
  }
}

function parseToolRequest(value: unknown): FileRequestInput {
  const args = object(value, "tool arguments");
  exactKeys(args, ["path", "need", "justification"], "tool arguments");
  return parseRequestInput({
    need: args.need,
    justification: args.justification,
    suggested_rule: { "fs.ro": args.path },
  });
}

function parseMessage(value: unknown): PaguMcpMessage {
  const message = object(value, "message");
  if (message.jsonrpc !== "2.0") {
    throw new Error('message.jsonrpc: expected "2.0"');
  }
  if (typeof message.method !== "string") {
    throw new Error("message.method: expected a string");
  }
  if (
    message.id !== undefined && typeof message.id !== "string" &&
    typeof message.id !== "number"
  ) {
    throw new Error("message.id: expected a string or number");
  }
  if (
    message.params !== undefined &&
    (message.params === null || typeof message.params !== "object" ||
      Array.isArray(message.params))
  ) {
    throw new Error("message.params: expected an object");
  }
  return message as PaguMcpMessage;
}

function toolFailure(id: string | number, reason: unknown): PaguMcpResponse {
  return response(id, {
    content: [{
      type: "text",
      text: reason instanceof Error ? reason.message : String(reason),
    }],
    isError: true,
  });
}

/** One MCP connection. It deliberately has no operator-resolution port. */
export function createPaguMcpSession(
  requestRead: PaguReadRequest = fileRequest,
): PaguMcpSession {
  let initialized = false;
  return {
    async handle(value) {
      let message: PaguMcpMessage;
      try {
        message = parseMessage(value);
      } catch (reason) {
        return error(
          null,
          -32600,
          reason instanceof Error ? reason.message : String(reason),
        );
      }
      if (message.id === undefined) return null;
      if (message.method === "initialize") {
        const requested = message.params?.protocolVersion;
        const protocolVersion = typeof requested === "string" &&
            SUPPORTED_PROTOCOLS.has(requested)
          ? requested
          : LATEST_PROTOCOL;
        initialized = true;
        return response(message.id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: {
            name: "pagu",
            version: "0.1.0",
            description: "Request-only access to the enclosing pagu gate",
          },
        });
      }
      if (!initialized) {
        return error(message.id, -32002, "server is not initialized");
      }
      if (message.method === "ping") return response(message.id, {});
      if (message.method === "tools/list") {
        return response(message.id, { tools: [PAGU_MCP_TOOL] });
      }
      if (message.method === "tools/call") {
        const name = message.params?.name;
        if (name !== PAGU_MCP_TOOL.name) {
          return error(
            message.id,
            -32602,
            `unknown tool ${JSON.stringify(name)}`,
          );
        }
        let input: FileRequestInput;
        try {
          input = parseToolRequest(message.params?.arguments);
        } catch (reason) {
          return toolFailure(message.id, reason);
        }
        try {
          const decision = await requestRead(input);
          return response(message.id, {
            content: [{ type: "text", text: JSON.stringify(decision) }],
            structuredContent: { decision },
            isError: false,
          });
        } catch (reason) {
          return toolFailure(message.id, reason);
        }
      }
      return error(message.id, -32601, "method not found");
    },
  };
}

async function* lines(
  input: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        yield line;
        newline = buffered.indexOf("\n");
      }
      if (done) break;
    }
    if (buffered !== "") yield buffered;
  } finally {
    reader.releaseLock();
  }
}

export interface PaguMcpStdioOptions {
  readonly input?: ReadableStream<Uint8Array>;
  readonly write?: (message: PaguMcpResponse) => Promise<void>;
  readonly requestRead?: PaguReadRequest;
}

/** Dependency-free newline-delimited JSON-RPC over stdio. */
export async function servePaguMcpStdio(
  options: PaguMcpStdioOptions = {},
): Promise<void> {
  const input = options.input ?? Deno.stdin.readable;
  const write = options.write ?? (async (message: PaguMcpResponse) => {
    const encoded = new TextEncoder().encode(JSON.stringify(message) + "\n");
    let offset = 0;
    while (offset < encoded.length) {
      offset += await Deno.stdout.write(encoded.subarray(offset));
    }
  });
  const session = createPaguMcpSession(options.requestRead);
  const cancelled = new Set<string | number>();
  const inFlight = new Set<string | number>();
  const pending = new Set<Promise<void>>();
  let writeTail = Promise.resolve();
  let outputFailure: unknown;
  const enqueue = (message: PaguMcpResponse): Promise<void> => {
    writeTail = writeTail
      .then(() => write(message))
      .catch((error) => outputFailure ??= error);
    return writeTail;
  };
  for await (const line of lines(input)) {
    if (line === "") continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      await enqueue(error(null, -32700, "parse error"));
      continue;
    }
    const record = message && typeof message === "object" &&
        !Array.isArray(message)
      ? message as Record<string, unknown>
      : undefined;
    if (
      record?.jsonrpc === "2.0" &&
      record.method === "notifications/cancelled" &&
      record.id === undefined
    ) {
      const requestId = record.params &&
          typeof record.params === "object" &&
          !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>).requestId
        : undefined;
      if (
        (typeof requestId === "string" || typeof requestId === "number") &&
        inFlight.has(requestId)
      ) {
        // Filing is an authoritative gate event and cannot be retracted through
        // the inhabitant protocol. Cancellation only suppresses the stale MCP
        // response; the host may still decide the retained request.
        cancelled.add(requestId);
      }
      continue;
    }
    const requestId = typeof record?.id === "string" ||
        typeof record?.id === "number"
      ? record.id
      : undefined;
    if (requestId !== undefined) inFlight.add(requestId);
    const work = (async () => {
      try {
        const result = await session.handle(message);
        if (result && (requestId === undefined || !cancelled.has(requestId))) {
          await enqueue(result);
        }
      } finally {
        if (requestId !== undefined) {
          inFlight.delete(requestId);
          cancelled.delete(requestId);
        }
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }
  await Promise.all(pending);
  await writeTail;
  if (outputFailure !== undefined) throw outputFailure;
}
