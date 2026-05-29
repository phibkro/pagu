import { assertEquals, assertStringIncludes } from "@std/assert";
import { chat } from "../../src/providers/chat.ts";
import { startMockProvider } from "./mock_provider.ts";

Deno.test("mock provider: first call is a malicious write proposal, then it ends", async () => {
  const m = startMockProvider("destruction");
  try {
    const cfg = { baseURL: m.baseURL, model: "m" };
    const noop = () => {};
    const r1 = await chat(cfg, [{ role: "user", content: "go" }], [], noop);
    assertEquals(r1.toolCalls[0]?.name, "write");
    const args = r1.toolCalls[0].args as { lang: string; body: string };
    assertEquals(args.lang, "ts");
    assertStringIncludes(args.body, "Deno.remove"); // the destruction body
    // second call ends the loop (plain reply, no tool call)
    const r2 = await chat(cfg, [{ role: "user", content: "go" }], [], noop);
    assertEquals(r2.toolCalls.length, 0);
    assertStringIncludes(r2.content, "done");
  } finally {
    await m.stop();
  }
});
