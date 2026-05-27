import { assertEquals } from "jsr:@std/assert@^1";
import { chat } from "./chat.ts";

// Hand-rolled HTTP mock (aimock pattern), OpenAI Chat Completions shape.
// Run with: deno test --allow-net

Deno.test("parses content + tool calls (arguments is a JSON string)", async () => {
  let seenPath = "";
  let seenAuth: string | null = null;
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    seenPath = new URL(req.url).pathname;
    seenAuth = req.headers.get("authorization");
    return Response.json({
      choices: [{
        message: {
          role: "assistant",
          content: "looking",
          tool_calls: [{
            function: { name: "read", arguments: '{"path":"./photos"}' },
          }],
        },
      }],
    });
  });
  try {
    const { port } = server.addr as Deno.NetAddr;
    const r = await chat(
      { baseURL: `http://localhost:${port}/v1`, model: "m", apiKey: "sk-x" },
      [{ role: "user", content: "list" }],
      [{ name: "read", description: "read", parameters: {} }],
    );
    assertEquals(seenPath, "/v1/chat/completions");
    assertEquals(seenAuth, "Bearer sk-x");
    assertEquals(r.content, "looking");
    assertEquals(r.toolCalls, [{ name: "read", args: { path: "./photos" } }]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("streaming: forwards content tokens live, reassembles tool calls", async () => {
  // SSE deltas: content arrives in pieces; a tool call's name comes once and
  // its arguments stream across frames (the fiddly part we must reassemble).
  const frames = [
    `data: {"choices":[{"delta":{"content":"Hel"}}]}\n`,
    `data: {"choices":[{"delta":{"content":"lo"}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"./x\\"}"}}]}}]}\n`,
    `data: [DONE]\n`,
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
    const seen: string[] = [];
    const r = await chat(
      { baseURL: `http://localhost:${port}/v1`, model: "m" },
      [{ role: "user", content: "hi" }],
      [{ name: "read", description: "read", parameters: {} }],
      (t) => seen.push(t),
    );
    assertEquals(seen, ["Hel", "lo"]); // streamed live, in order
    assertEquals(r.content, "Hello");
    assertEquals(r.toolCalls, [{ name: "read", args: { path: "./x" } }]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("a non-OK response throws a one-line error from the JSON body", async () => {
  const server = Deno.serve(
    { port: 0, onListen() {} },
    () =>
      new Response(
        JSON.stringify({ error: { message: "credit balance is too low" } }),
        { status: 400 },
      ),
  );
  try {
    const { port } = server.addr as Deno.NetAddr;
    let caught = "";
    try {
      await chat({ baseURL: `http://localhost:${port}/v1`, model: "m" }, [
        { role: "user", content: "hi" },
      ]);
    } catch (e) {
      caught = e instanceof Error ? e.message : String(e);
    }
    // Clean one line — the API's error.message, not the raw JSON dump.
    assertEquals(caught, "provider 400: credit balance is too low");
  } finally {
    await server.shutdown();
  }
});

Deno.test("no key -> no Authorization header; tolerates no tool calls", async () => {
  let hadAuth = true;
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    hadAuth = req.headers.has("authorization");
    return Response.json({
      choices: [{ message: { role: "assistant", content: "done" } }],
    });
  });
  try {
    const { port } = server.addr as Deno.NetAddr;
    const r = await chat(
      { baseURL: `http://localhost:${port}/v1`, model: "m" },
      [{ role: "user", content: "hi" }],
    );
    assertEquals(hadAuth, false);
    assertEquals(r.content, "done");
    assertEquals(r.toolCalls, []);
  } finally {
    await server.shutdown();
  }
});
