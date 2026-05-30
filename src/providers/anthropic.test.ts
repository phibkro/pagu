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
    // user + tool(→user) coalesced into a single user turn; being the last turn
    // it also carries the message-prefix cache breakpoint (a one-block array).
    assertEquals(body.messages, [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "list photos\n\n[fs:./photos]\na.jpg",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
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

Deno.test("anthropic: message-prefix cache breakpoint on the last turn (multi-turn growing prefix)", async () => {
  // The second cache breakpoint: in addition to the stable tools+system prefix
  // (the system block), the last message turn carries a cache_control so the
  // growing conversation prefix is cached and read at ~0.1x on later turns.
  // Anthropic caches the prefix up to and including the marked block; the next
  // turn finds it as a prefix hit (incremental caching). We coalesce consecutive
  // same-role turns first, so the breakpoint lands on the *coalesced* last turn.
  let body: {
    system?: Array<{ type: string; text: string; cache_control?: unknown }>;
    messages?: Array<{
      role: string;
      content:
        | string
        | Array<{ type: string; text: string; cache_control?: unknown }>;
    }>;
  } = {};
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
      },
      [
        { role: "system", content: "SYS" },
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
        { role: "tool", content: "[fs:./x]\nfile contents" }, // tool→user, coalesced
      ],
    );

    // System still carries its own breakpoint (the stable tools+system prefix).
    assertEquals(body.system, [
      { type: "text", text: "SYS", cache_control: { type: "ephemeral" } },
    ]);

    const msgs = body.messages!;
    // Earlier turns stay plain strings — no breakpoint, so they can't write a
    // distinct per-turn entry; they're read as part of the cached prefix.
    assertEquals(msgs[0], { role: "user", content: "first question" });
    assertEquals(msgs[1], { role: "assistant", content: "first answer" });
    // The last (coalesced user) turn carries the breakpoint, as a one-block array.
    assertEquals(msgs[2], {
      role: "user",
      content: [
        {
          type: "text",
          text: "second question\n\n[fs:./x]\nfile contents",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("anthropic: no message breakpoint when there are no turns (system-only)", async () => {
  // A degenerate request with only a system message must not crash or attach a
  // breakpoint to a non-existent last turn — the system breakpoint is enough.
  let body: { messages?: unknown[] } = {};
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    body = await req.json();
    return Response.json({ content: [{ type: "text", text: "ok" }] });
  });
  try {
    const { port } = server.addr as Deno.NetAddr;
    // First message is assistant-only after the system split → the "(continue)"
    // user turn is synthesized; assert the breakpoint lands on it (the last turn)
    // rather than throwing.
    await chat(
      {
        baseURL: `http://localhost:${port}`,
        model: "claude-opus-4-8",
        apiKey: "k",
        format: "anthropic",
      },
      [{ role: "assistant", content: "lone assistant turn" }],
    );
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    // user("(continue)") + assistant; breakpoint on the last (assistant) turn.
    assertEquals(msgs.length, 2);
    assertEquals(msgs[0], { role: "user", content: "(continue)" });
    assertEquals(msgs[1], {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "lone assistant turn",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
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

Deno.test("anthropic: usage parsed (input/output + cache read/creation)", async () => {
  const server = Deno.serve(
    { port: 0, onListen() {} },
    () =>
      Response.json({
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 200,
          output_tokens: 30,
          cache_read_input_tokens: 150,
          cache_creation_input_tokens: 50,
        },
      }),
  );
  try {
    const { port } = server.addr as Deno.NetAddr;
    const r = await chat(
      {
        baseURL: `http://localhost:${port}`,
        model: "claude-opus-4-8",
        apiKey: "k",
        format: "anthropic",
      },
      [{ role: "user", content: "hi" }],
    );
    assertEquals(r.usage, {
      inputTokens: 200,
      outputTokens: 30,
      cacheReadTokens: 150,
      cacheCreationTokens: 50,
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("anthropic: stop_reason 'max_tokens' sets truncated; absent otherwise", async () => {
  let cut = true;
  const server = Deno.serve(
    { port: 0, onListen() {} },
    () =>
      Response.json({
        content: [{ type: "text", text: "partial" }],
        stop_reason: cut ? "max_tokens" : "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
  );
  try {
    const { port } = server.addr as Deno.NetAddr;
    const cfg = {
      baseURL: `http://localhost:${port}`,
      model: "claude-opus-4-8",
      apiKey: "k",
      format: "anthropic" as const,
    };
    const r = await chat(cfg, [{ role: "user", content: "hi" }]);
    assertEquals(r.truncated, true); // hit the output-token cap
    cut = false;
    const r2 = await chat(cfg, [{ role: "user", content: "hi" }]);
    assertEquals(r2.truncated, undefined); // normal stop → no flag
  } finally {
    await server.shutdown();
  }
});

Deno.test("anthropic streaming: stop_reason 'max_tokens' in message_delta sets truncated", async () => {
  const frames = [
    `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":30}}\n\n`,
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
    const r = await chat(
      {
        baseURL: `http://localhost:${port}`,
        model: "claude-opus-4-8",
        apiKey: "k",
        format: "anthropic",
      },
      [{ role: "user", content: "hi" }],
      [],
      () => {}, // onToken → streaming
    );
    assertEquals(r.content, "partial");
    assertEquals(r.truncated, true);
  } finally {
    await server.shutdown();
  }
});

Deno.test("anthropic streaming: usage from message_start (input+cache) + message_delta (output)", async () => {
  const frames = [
    `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":200,"output_tokens":1,"cache_read_input_tokens":150,"cache_creation_input_tokens":50}}}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":30}}\n\n`,
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
    const r = await chat(
      {
        baseURL: `http://localhost:${port}`,
        model: "claude-opus-4-8",
        apiKey: "k",
        format: "anthropic",
      },
      [{ role: "user", content: "hi" }],
      [],
      () => {}, // onToken → streaming
    );
    assertEquals(r.usage, {
      inputTokens: 200,
      outputTokens: 30,
      cacheReadTokens: 150,
      cacheCreationTokens: 50,
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("anthropic streaming: an in-stream error event throws (e.g. 529 overloaded)", async () => {
  const frames = [
    `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n`,
    `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`,
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
    let caught = "";
    try {
      await chat(
        {
          baseURL: `http://localhost:${port}`,
          model: "claude-opus-4-8",
          apiKey: "k",
          format: "anthropic",
        },
        [{ role: "user", content: "hi" }],
        [],
        () => {},
      );
    } catch (e) {
      caught = e instanceof Error ? e.message : String(e);
    }
    assertEquals(caught.toLowerCase().includes("overloaded"), true);
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
