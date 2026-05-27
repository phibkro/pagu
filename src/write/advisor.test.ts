import { assertEquals } from "@std/assert";
import { formatAdvisory, runAdvisor } from "./advisor.ts";

// --- formatAdvisory (pure) ---

Deno.test("formatAdvisory: empty array produces empty string", () => {
  assertEquals(formatAdvisory([]), "");
});

Deno.test("formatAdvisory: each flag is prefixed with [advisory]", () => {
  assertEquals(
    formatAdvisory(["concern one", "concern two"]),
    "[advisory] concern one\n[advisory] concern two",
  );
});

// --- runAdvisor (HTTP mock, same aimock pattern as provider/chat.test.ts) ---

Deno.test("runAdvisor: parses JSON array from model response", async () => {
  const server = Deno.serve(
    { port: 0, onListen() {} },
    () =>
      Response.json({
        choices: [{
          message: { role: "assistant", content: '["flag one","flag two"]' },
        }],
      }),
  );
  try {
    const { port } = server.addr as Deno.NetAddr;
    const flags = await runAdvisor({
      task: "count files",
      script: 'console.log("hi")',
      perms: ["allow-read=/repo"],
      provider: { baseURL: `http://localhost:${port}/v1`, model: "m" },
    });
    assertEquals(flags, ["flag one", "flag two"]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("runAdvisor: JSON array embedded in prose is extracted", async () => {
  const server = Deno.serve(
    { port: 0, onListen() {} },
    () =>
      Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: 'Here are concerns:\n["flag a"]\nThat is all.',
          },
        }],
      }),
  );
  try {
    const { port } = server.addr as Deno.NetAddr;
    const flags = await runAdvisor({
      task: "t",
      script: "s",
      perms: [],
      provider: { baseURL: `http://localhost:${port}/v1`, model: "m" },
    });
    assertEquals(flags, ["flag a"]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("runAdvisor: non-string array elements are filtered out", async () => {
  const server = Deno.serve(
    { port: 0, onListen() {} },
    () =>
      Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: '["ok", 42, null, "also ok"]',
          },
        }],
      }),
  );
  try {
    const { port } = server.addr as Deno.NetAddr;
    const flags = await runAdvisor({
      task: "t",
      script: "s",
      perms: [],
      provider: { baseURL: `http://localhost:${port}/v1`, model: "m" },
    });
    assertEquals(flags, ["ok", "also ok"]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("runAdvisor: returns [] on malformed JSON — fails open", async () => {
  const server = Deno.serve(
    { port: 0, onListen() {} },
    () =>
      Response.json({
        choices: [{
          message: { role: "assistant", content: "not json at all" },
        }],
      }),
  );
  try {
    const { port } = server.addr as Deno.NetAddr;
    const flags = await runAdvisor({
      task: "t",
      script: "s",
      perms: [],
      provider: { baseURL: `http://localhost:${port}/v1`, model: "m" },
    });
    assertEquals(flags, []);
  } finally {
    await server.shutdown();
  }
});

Deno.test("runAdvisor: returns [] on HTTP error — fails open", async () => {
  const server = Deno.serve(
    { port: 0, onListen() {} },
    () => new Response("error", { status: 500 }),
  );
  try {
    const { port } = server.addr as Deno.NetAddr;
    const flags = await runAdvisor({
      task: "t",
      script: "s",
      perms: [],
      provider: { baseURL: `http://localhost:${port}/v1`, model: "m" },
    });
    assertEquals(flags, []);
  } finally {
    await server.shutdown();
  }
});
