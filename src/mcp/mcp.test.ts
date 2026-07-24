import { assertEquals, assertMatch } from "@std/assert";
import {
  createPaguMcpSession,
  PAGU_MCP_TOOL,
  type PaguMcpMessage,
  type PaguMcpResponse,
  servePaguMcpStdio,
} from "./index.ts";
import {
  fileRequest,
  type FileRequestInput,
  type GateDecision,
  serveGate,
} from "../request/index.ts";

const APPROVED: GateDecision = {
  verdict: "approve",
  scope: "session",
  tier: "operator",
  rationale: "approved by host",
  granted_rule: { "fs.ro": "/srv/share/reference/api" },
};

function request(
  id: number,
  method: string,
  params?: Record<string, unknown>,
): PaguMcpMessage {
  return { jsonrpc: "2.0", id, method, params };
}

Deno.test("law: MCP exposes one request-only inhabitant tool", async () => {
  const requested: FileRequestInput[] = [];
  const session = createPaguMcpSession((input) => {
    requested.push(input);
    return Promise.resolve(APPROVED);
  });

  assertEquals(
    await session.handle(request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    })),
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: {
          name: "pagu",
          version: "0.1.0",
          description: "Request-only access to the enclosing pagu gate",
        },
      },
    },
  );

  const listed = await session.handle(request(2, "tools/list"));
  assertEquals(listed, {
    jsonrpc: "2.0",
    id: 2,
    result: { tools: [PAGU_MCP_TOOL] },
  });
  if (!listed || !("result" in listed)) throw new Error("expected tool list");
  const names = (
    listed.result.tools as ReadonlyArray<{ readonly name: string }>
  ).map((tool) => tool.name);
  assertEquals(names, ["request_read_access"]);
  assertEquals(names.includes("resolve"), false);
  assertEquals(names.includes("persist"), false);
  assertEquals(names.includes("grant"), false);

  const called = await session.handle(request(3, "tools/call", {
    name: "request_read_access",
    arguments: {
      path: "/srv/share/reference/api",
      need: "read API definitions",
      justification: "verify the local adapter",
    },
  }));
  assertEquals(requested, [{
    need: "read API definitions",
    justification: "verify the local adapter",
    suggested_rule: { "fs.ro": "/srv/share/reference/api" },
  }]);
  assertEquals(called, {
    jsonrpc: "2.0",
    id: 3,
    result: {
      content: [{
        type: "text",
        text: JSON.stringify(APPROVED),
      }],
      structuredContent: { decision: APPROVED },
      isError: false,
    },
  });
});

Deno.test("falsifier 1: MCP cannot resolve or smuggle authority", async () => {
  let requested = 0;
  const session = createPaguMcpSession(() => {
    requested++;
    return Promise.resolve(APPROVED);
  });
  await session.handle(request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  }));

  const unknown = await session.handle(request(2, "tools/call", {
    name: "resolve",
    arguments: { request: "r1", scope: "persist" },
  }));
  assertEquals(unknown, {
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32602, message: 'unknown tool "resolve"' },
  });

  const smuggled = await session.handle(request(3, "tools/call", {
    name: "request_read_access",
    arguments: {
      path: "/srv/share/reference/api",
      need: "read API definitions",
      justification: "verify",
      scope: "persist",
      verdict: "approve",
    },
  }));
  assertEquals(smuggled?.jsonrpc, "2.0");
  assertEquals(smuggled?.id, 3);
  assertEquals("result" in smuggled!, true);
  if (!("result" in smuggled!)) throw new Error("expected tool result");
  assertEquals(smuggled.result.isError, true);
  assertMatch(
    (smuggled.result.content as Array<{ text: string }>)[0].text,
    /unknown key "scope"/,
  );
  assertEquals(requested, 0);
});

Deno.test("MCP rejects tool use before initialization", async () => {
  const session = createPaguMcpSession(() => Promise.resolve(APPROVED));
  assertEquals(await session.handle(request(1, "tools/list")), {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32002, message: "server is not initialized" },
  });
});

Deno.test("MCP stdio carries newline-delimited JSON-RPC without stdout noise", async () => {
  const input = [
    "{not-json}",
    JSON.stringify(request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    })),
    JSON.stringify(request(2, "tools/list")),
    "",
  ].join("\n");
  const written: PaguMcpResponse[] = [];

  await servePaguMcpStdio({
    input: new Blob([input]).stream(),
    write(message) {
      written.push(message);
      return Promise.resolve();
    },
    requestRead: () => Promise.resolve(APPROVED),
  });

  assertEquals(written[0], {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "parse error" },
  });
  assertEquals(written[1]?.id, 1);
  assertEquals(written[2], {
    jsonrpc: "2.0",
    id: 2,
    result: { tools: [PAGU_MCP_TOOL] },
  });
});

Deno.test("law: MCP services ping while retaining a cancelled gate request", async () => {
  const decision = Promise.withResolvers<GateDecision>();
  const filed = Promise.withResolvers<void>();
  const ping = Promise.withResolvers<void>();
  const written: PaguMcpResponse[] = [];
  const input = [
    request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
    request(2, "tools/call", {
      name: "request_read_access",
      arguments: {
        path: "/srv/share/reference/api",
        need: "read API definitions",
        justification: "verify concurrent MCP dispatch",
      },
    }),
    request(3, "ping"),
    {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 2, reason: "client stopped waiting" },
    },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";

  const serving = servePaguMcpStdio({
    input: new Blob([input]).stream(),
    write(message) {
      written.push(message);
      if (message.id === 3) ping.resolve();
      return Promise.resolve();
    },
    requestRead() {
      filed.resolve();
      return decision.promise;
    },
  });
  const timeout = setTimeout(
    () => ping.reject(new Error("ping blocked behind gate request")),
    1_000,
  );
  try {
    await Promise.all([filed.promise, ping.promise]);
  } finally {
    clearTimeout(timeout);
  }
  assertEquals(
    written.some((message) => message.id === 2),
    false,
  );

  decision.resolve(APPROVED);
  await serving;
  assertEquals(
    written.some((message) => message.id === 2),
    false,
  );
});

Deno.test("MCP ignores unknown cancellation and validates its envelope", async () => {
  const written: PaguMcpResponse[] = [];
  const input = [
    request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
    {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 2, reason: "not in flight" },
    },
    {
      method: "notifications/cancelled",
      params: { requestId: 2, reason: "invalid envelope" },
    },
    request(2, "tools/call", {
      name: "request_read_access",
      arguments: {
        path: "/srv/share/reference/api",
        need: "read API definitions",
        justification: "verify cancellation ID reuse",
      },
    }),
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";

  await servePaguMcpStdio({
    input: new Blob([input]).stream(),
    write(message) {
      written.push(message);
      return Promise.resolve();
    },
    requestRead: () => Promise.resolve(APPROVED),
  });

  assertEquals(
    written.some((message) => "result" in message && message.id === 2),
    true,
  );
  assertEquals(
    written.some((message) =>
      "error" in message && message.id === null &&
      message.error.code === -32600
    ),
    true,
  );
});

Deno.test("MCP request traverses the real append-and-await gate socket", async () => {
  const root = await Deno.makeTempDir();
  const socket = `${root}/request.sock`;
  let received: FileRequestInput | undefined;
  const gate = await serveGate({
    socket,
    gate: {
      handle(input) {
        received = input;
        return Promise.resolve(APPROVED);
      },
      close() {},
    },
  });
  try {
    const session = createPaguMcpSession((input) =>
      fileRequest(input, { socket })
    );
    await session.handle(request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }));
    const result = await session.handle(request(2, "tools/call", {
      name: "request_read_access",
      arguments: {
        path: "/srv/share/reference/api",
        need: "read API definitions",
        justification: "verify the full request transport",
      },
    }));
    assertEquals(received, {
      need: "read API definitions",
      justification: "verify the full request transport",
      suggested_rule: { "fs.ro": "/srv/share/reference/api" },
    });
    assertEquals(result && "result" in result, true);
  } finally {
    await gate.close();
    await Deno.remove(root, { recursive: true });
  }
});
