import { assertEquals } from "@std/assert";
import { chat } from "./chat.ts";
import { fetchModelsAnthropic } from "./anthropic.ts";

Deno.test("fetchModelsAnthropic: GET /v1/models with x-api-key + version", async () => {
  let seenPath = "";
  let seenKey: string | null = null;
  let seenVer: string | null = null;
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    seenPath = new URL(req.url).pathname;
    seenKey = req.headers.get("x-api-key");
    seenVer = req.headers.get("anthropic-version");
    return Response.json({ data: [{ id: "claude-x" }] });
  });
  try {
    const { port } = server.addr as Deno.NetAddr;
    const models = await fetchModelsAnthropic({
      baseURL: `http://localhost:${port}`,
      model: "m",
      apiKey: "k",
      format: "anthropic",
    });
    assertEquals(seenPath, "/v1/models");
    assertEquals(seenKey, "k");
    assertEquals(seenVer, "2023-06-01");
    assertEquals(models, ["claude-x"]);
  } finally {
    await server.shutdown();
  }
});

// Hand-rolled HTTP mock for the Anthropic Messages API. Run with:
// deno test --allow-net

Deno.test("anthropic: system split out, tool→user coalesced, tool_use parsed", async () => {
  let path = "";
  let key: string | null = null;
  let version: string | null = null;
  let body: {
    system?: Array<{ type: string; text: string; cache_control?: unknown }>;
    max_tokens?: number;
    messages?: unknown;
    tools?: Array<Record<string, unknown>>;
  } = {};

  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    path = new URL(req.url).pathname;
    key = req.headers.get("x-api-key");
    version = req.headers.get("anthropic-version");
    body = await req.json();
    return Response.json({
      content: [
        { type: "text", text: "let me look" },
        {
          type: "tool_use",
          id: "t1",
          name: "read",
          input: { path: "./photos" },
        },
      ],
    });
  });
  try {
    const { port } = server.addr as Deno.NetAddr;
    const r = await chat(
      {
        baseURL: `http://localhost:${port}`,
        model: "claude-sonnet-4.5",
        apiKey: "sk-ant-x",
        format: "anthropic",
      },
      [
        { role: "system", content: "SYS" },
        { role: "user", content: "list photos" },
        { role: "tool", content: "[fs:./photos]\na.jpg" },
      ],
      [{
        name: "read",
        description: "read a path",
        parameters: { type: "object" },
      }],
    );

    assertEquals(path, "/v1/messages");
    assertEquals(key, "sk-ant-x");
    assertEquals(version, "2023-06-01");
    // System is sent as a structured text block with a cache breakpoint, so the
    // stable tools+system prefix is cached (read at ~0.1x on later turns).
    assertEquals(body.system, [
      { type: "text", text: "SYS", cache_control: { type: "ephemeral" } },
    ]);
    assertEquals(typeof body.max_tokens, "number");
    // user + tool(→user) coalesced into a single user turn
    assertEquals(body.messages, [
      { role: "user", content: "list photos\n\n[fs:./photos]\na.jpg" },
    ]);
    // tools mapped to Anthropic's input_schema shape
    assertEquals(body.tools?.[0], {
      name: "read",
      description: "read a path",
      input_schema: { type: "object" },
    });
    assertEquals(r.content, "let me look");
    assertEquals(r.toolCalls, [{ name: "read", args: { path: "./photos" } }]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("anthropic: max_tokens reflects cfg.maxTokens (overrides the 4096 default)", async () => {
  let body: { max_tokens?: number } = {};
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    body = await req.json();
    return Response.json({ content: [{ type: "text", text: "ok" }] });
  });
  try {
    const { port } = server.addr as Deno.NetAddr;
    await chat(
      {
        baseURL: `http://localhost:${port}`,
        model: "claude-opus-4-8",
        apiKey: "k",
        format: "anthropic",
        maxTokens: 8192,
      },
      [{ role: "user", content: "hi" }],
    );
    assertEquals(body.max_tokens, 8192);
  } finally {
    await server.shutdown();
  }
});

Deno.test("anthropic streaming: forwards text deltas live, reassembles tool_use input", async () => {
  // The Anthropic SSE event shape: text streams as `text_delta`; a tool call's
  // name arrives in `content_block_start` and its input streams as
  // `input_json_delta` fragments (the fiddly part we reassemble + parse).
  let sawStream = false;
  const frames = [
    `event: message_start\ndata: {"type":"message_start","message":{}}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"read","input":{}}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"pa"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"th\\":\\"./x\\"}"}}\n\n`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ];
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    sawStream = (await req.json()).stream === true;
    return new Response(frames.join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  try {
    const { port } = server.addr as Deno.NetAddr;
    const seen: string[] = [];
    const r = await chat(
      {
        baseURL: `http://localhost:${port}`,
        model: "claude-opus-4-8",
        apiKey: "sk-ant-x",
        format: "anthropic",
      },
      [{ role: "user", content: "hi" }],
      [{ name: "read", description: "read", parameters: { type: "object" } }],
      (t) => seen.push(t), // onToken → triggers streaming
    );
    assertEquals(sawStream, true); // the request opted into streaming
    assertEquals(seen, ["Hel", "lo"]); // text streamed live, in order
    assertEquals(r.content, "Hello");
    assertEquals(r.toolCalls, [{ name: "read", args: { path: "./x" } }]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("anthropic streaming: thinking_delta routes to onReasoning, not content", async () => {
  const frames = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pondering"}}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ];
  const server = Deno.serve(
    { port: 0, onListen() {} },
    () =>
      new Response(frames.join(""), {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  try {
    const { port } = server.addr as Deno.NetAddr;
    const content: string[] = [];
    const reasoning: string[] = [];
    const r = await chat(
      {
        baseURL: `http://localhost:${port}`,
        model: "claude-opus-4-8",
        apiKey: "k",
        format: "anthropic",
      },
      [{ role: "user", content: "hi" }],
      [],
      (t) => content.push(t),
      (t) => reasoning.push(t),
    );
    assertEquals(content.join(""), "answer");
    assertEquals(reasoning.join(""), "pondering"); // ephemeral, separate channel
    assertEquals(r.content, "answer"); // thinking not in the persisted content
  } finally {
    await server.shutdown();
  }
});
