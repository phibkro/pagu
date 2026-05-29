import { assertEquals, assertStringIncludes } from "@std/assert";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  acpApprover,
  type AcpConn,
  acpUI,
  commandsUpdate,
  entryUpdate,
  historyUpdates,
} from "./acp.ts";
import type { SlashCommand } from "../commands.ts";
import type { ScriptEntry } from "../context.ts";

// A fake connection that records sessionUpdate calls and returns a canned
// requestPermission outcome.
function fakeConn(
  outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string },
): { conn: AcpConn; updates: SessionNotification[] } {
  const updates: SessionNotification[] = [];
  const conn: AcpConn = {
    sessionUpdate: (p) => {
      updates.push(p);
      return Promise.resolve();
    },
    requestPermission: () => Promise.resolve({ outcome }),
  };
  return { conn, updates };
}

const SCRIPT: ScriptEntry = {
  kind: "script",
  id: "s1",
  lang: "ts",
  body: 'console.log("hi");',
};

// --- acpUI ---

Deno.test("acpUI.show sends an agent_message_chunk with the text", async () => {
  const { conn, updates } = fakeConn({
    outcome: "selected",
    optionId: "allow",
  });
  acpUI(conn, "sess-1").show("hello world");
  await Promise.resolve(); // let the fire-and-forget update settle
  assertEquals(updates.length, 1);
  assertEquals(updates[0], {
    sessionId: "sess-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello world" },
    },
  });
});

Deno.test("acpUI.show flushes pending stream output first, preserving order", async () => {
  const { conn, updates } = fakeConn({
    outcome: "selected",
    optionId: "allow",
  });
  const ui = acpUI(conn, "sess-1", 50);
  ui.stream!("partial "); // buffered, not yet sent
  ui.show("RESULT"); // must flush the buffer, then send itself
  await Promise.resolve();
  assertEquals(updates.length, 2);
  assertEquals(
    (updates[0].update as { content: { text: string } }).content.text,
    "partial ",
  );
  assertEquals(
    (updates[1].update as { content: { text: string } }).content.text,
    "RESULT",
  );
});

Deno.test("acpUI: reasoning + marker → thought chunk; content → message chunk", async () => {
  const { conn, updates } = fakeConn({ outcome: "cancelled" });
  const ui = acpUI(conn, "s");
  ui.stream!("answer", "content");
  ui.stream!("thinking", "reasoning");
  ui.stream!("· read x", "marker");
  ui.show("RESULT"); // flush all channel buffers, then send the result
  await Promise.resolve();
  const text = (sk: string) =>
    updates
      .filter((u) => u.update.sessionUpdate === sk)
      .map((u) => (u.update as { content: { text: string } }).content.text)
      .join("");
  const thoughts = text("agent_thought_chunk");
  const messages = text("agent_message_chunk");
  assertStringIncludes(thoughts, "thinking");
  assertStringIncludes(thoughts, "· read x");
  assertStringIncludes(messages, "answer");
  assertStringIncludes(messages, "RESULT");
});

Deno.test("acpUI.status is a no-op (no session update)", async () => {
  const { conn, updates } = fakeConn({
    outcome: "selected",
    optionId: "allow",
  });
  acpUI(conn, "sess-1").status("thinking…");
  await Promise.resolve();
  assertEquals(updates.length, 0);
});

// --- acpApprover ---

Deno.test("acpApprover returns approve when outcome selects allow", async () => {
  const { conn } = fakeConn({ outcome: "selected", optionId: "allow" });
  const outcome = await acpApprover(conn, "sess-1")(SCRIPT, ["allow-read=."]);
  assertEquals(outcome, "approve");
});

Deno.test("acpApprover returns reject when outcome selects reject", async () => {
  const { conn } = fakeConn({ outcome: "selected", optionId: "reject" });
  const outcome = await acpApprover(conn, "sess-1")(SCRIPT, ["allow-read=."]);
  assertEquals(outcome, "reject");
});

Deno.test("acpApprover returns reject when outcome is cancelled", async () => {
  const { conn } = fakeConn({ outcome: "cancelled" });
  const outcome = await acpApprover(conn, "sess-1")(SCRIPT, []);
  assertEquals(outcome, "reject");
});

Deno.test("acpUI coalesces rapid stream chunks into one update", async () => {
  const { conn, updates } = fakeConn({
    outcome: "selected",
    optionId: "allow",
  });
  const ui = acpUI(conn, "sess-1", 10); // 10ms flush window
  ui.stream!("Hel");
  ui.stream!("lo");
  ui.stream!(" world");
  await new Promise((r) => setTimeout(r, 25)); // past the flush window
  assertEquals(updates.length, 1); // coalesced into one notification
  assertEquals(
    (updates[0].update as { content: { text: string } }).content.text,
    "Hello world",
  );
});

// --- historyUpdates (replay on session/load) ---

Deno.test("historyUpdates maps messages and actions, skipping bookkeeping", () => {
  const log = [
    { kind: "message", role: "user", text: "hi" },
    { kind: "message", role: "assistant", text: "hey" },
    { kind: "script", id: "s1", lang: "ts", body: "console.log(1);" },
    { kind: "perms", id: "s1", perms: [] }, // bookkeeping — skipped
  ] as unknown as Parameters<typeof historyUpdates>[0];
  const u = historyUpdates(log, "sess-1");
  assertEquals(u.length, 3); // 2 messages + 1 tool_call; perms skipped
  assertEquals(
    (u[0].update as { sessionUpdate: string }).sessionUpdate,
    "user_message_chunk",
  );
  assertEquals(
    (u[1].update as { sessionUpdate: string }).sessionUpdate,
    "agent_message_chunk",
  );
  assertEquals(
    (u[2].update as { sessionUpdate: string }).sessionUpdate,
    "tool_call",
  );
});

Deno.test("commandsUpdate advertises bare command names", () => {
  const cmds: SlashCommand[] = [
    { name: "/model", description: "set model", run: () => {} },
    { name: "/advisor", description: "toggle advisor", run: () => {} },
  ];
  const u = commandsUpdate(cmds, "sess-1");
  assertEquals(u, {
    sessionId: "sess-1",
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "model", description: "set model" },
        { name: "advisor", description: "toggle advisor" },
      ],
    },
  });
});

// --- entryUpdate (tool-call surfacing) ---

Deno.test("entryUpdate maps a script to an in-progress tool_call", () => {
  const e = {
    kind: "script",
    id: "s1",
    lang: "ts",
    body: "x",
  } as unknown as Parameters<typeof entryUpdate>[0];
  assertEquals(entryUpdate(e, "sess-1"), {
    sessionId: "sess-1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "s1",
      title: "Run script s1",
      kind: "execute",
      status: "in_progress",
    },
  });
});

Deno.test("acpUI.entries surfaces actions/results as tool calls, skipping messages", () => {
  const { conn, updates } = fakeConn({
    outcome: "selected",
    optionId: "allow",
  });
  acpUI(conn, "sess-1").entries!(
    [
      { kind: "message", role: "assistant", text: "hi" }, // streams — skipped
      { kind: "script", id: "s1", lang: "ts", body: "x" },
      { kind: "result", script: "s1", exit: 1, ranWith: [], output: "boom" },
    ] as unknown as Parameters<typeof historyUpdates>[0],
  );
  assertEquals(updates.length, 2); // message skipped
  assertEquals(
    (updates[0].update as { sessionUpdate: string }).sessionUpdate,
    "tool_call",
  );
  const upd = updates[1].update as { sessionUpdate: string; status: string };
  assertEquals(upd.sessionUpdate, "tool_call_update");
  assertEquals(upd.status, "failed"); // exit 1
});
