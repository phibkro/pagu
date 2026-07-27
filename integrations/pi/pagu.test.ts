import { assertEquals, assertRejects } from "@std/assert";
import {
  createPaguExtension,
  type PiExtensionApi,
  type PiToolDefinition,
} from "./pagu.ts";

function registeredTool(command: string, args: readonly string[]) {
  let tool: PiToolDefinition | undefined;
  createPaguExtension({ command, args })(
    {
      registerTool(definition) {
        tool = definition;
      },
    } satisfies PiExtensionApi,
  );
  if (!tool) throw new Error("extension did not register a tool");
  return tool;
}

const FAKE_MCP = `
const decoder = new TextDecoder();
let text = "";
for await (const chunk of Deno.stdin.readable) text += decoder.decode(chunk);
const messages = text.trim().split("\\n").map(JSON.parse);
for (const message of messages) {
  const result = message.id === 1
    ? {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "pagu-test", version: "0" },
    }
    : {
      content: [{ type: "text", text: "approved by fixture" }],
      structuredContent: {
        decision: {
          verdict: "approve",
          scope: "session",
          tier: "operator",
          rationale: "fixture",
          granted_rule: { "fs.ro": "/reference" },
        },
      },
      isError: false,
    };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
}
`;

Deno.test("law: Pi extension exposes one request-only native tool", () => {
  const tool = registeredTool(Deno.execPath(), ["eval", FAKE_MCP]);
  assertEquals(tool.name, "request_read_access");
  assertEquals(tool.parameters.required, ["path", "need", "justification"]);
  assertEquals(tool.parameters.additionalProperties, false);
});

Deno.test("Pi native tool traverses the packaged MCP contract", async () => {
  const tool = registeredTool(Deno.execPath(), ["eval", FAKE_MCP]);
  const result = await tool.execute(
    "call-1",
    {
      path: "/reference",
      need: "read API",
      justification: "verify compatibility",
    },
  );
  assertEquals(result.details, {
    decision: {
      verdict: "approve",
      scope: "session",
      tier: "operator",
      rationale: "fixture",
      granted_rule: { "fs.ro": "/reference" },
    },
  });
});

Deno.test("falsifier: Pi bridge fails loud on a parallel interface", async () => {
  const tool = registeredTool(Deno.execPath(), [
    "eval",
    "console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{admin:true}}))",
  ]);
  await assertRejects(
    () =>
      tool.execute("call-1", {
        path: "/reference",
        need: "read API",
        justification: "verify compatibility",
      }),
    Error,
    "missing structured decision",
  );
});
