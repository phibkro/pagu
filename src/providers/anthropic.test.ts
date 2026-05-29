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
    system?: string;
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
    assertEquals(body.system, "SYS");
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
