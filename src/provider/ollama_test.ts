import { assertEquals } from "jsr:@std/assert@^1";
import { chat } from "./ollama.ts";

// Hand-rolled HTTP mock (the aimock pattern) — no dependency. Run with:
//   deno test --allow-net

Deno.test("chat parses content + tool calls from a mocked /api/chat", async () => {
  let seenPath = "";
  const server = Deno.serve(
    { port: 0, onListen() {} },
    (req) => {
      seenPath = new URL(req.url).pathname;
      return Response.json({
        message: {
          role: "assistant",
          content: "let me look",
          tool_calls: [
            { function: { name: "read", arguments: { path: "./photos" } } },
          ],
        },
      });
    },
  );
  try {
    const { port } = server.addr as Deno.NetAddr;
    const r = await chat(
      { baseUrl: `http://localhost:${port}`, model: "test-model" },
      [{ role: "user", content: "list photos" }],
      [{ name: "read", description: "read a path", parameters: {} }],
    );
    assertEquals(seenPath, "/api/chat");
    assertEquals(r.content, "let me look");
    assertEquals(r.toolCalls, [{ name: "read", args: { path: "./photos" } }]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("chat tolerates a tool-call-free response", async () => {
  const server = Deno.serve(
    { port: 0, onListen() {} },
    () => Response.json({ message: { role: "assistant", content: "done" } }),
  );
  try {
    const { port } = server.addr as Deno.NetAddr;
    const r = await chat(
      { baseUrl: `http://localhost:${port}`, model: "test-model" },
      [{ role: "user", content: "hi" }],
    );
    assertEquals(r.content, "done");
    assertEquals(r.toolCalls, []);
  } finally {
    await server.shutdown();
  }
});
