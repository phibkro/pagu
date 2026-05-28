import { assertEquals } from "@std/assert";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { acpApprover, type AcpConn, acpUI } from "./acp.ts";
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

Deno.test("acpApprover returns true when outcome selects allow", async () => {
  const { conn } = fakeConn({ outcome: "selected", optionId: "allow" });
  const approved = await acpApprover(conn, "sess-1")(SCRIPT, ["allow-read=."]);
  assertEquals(approved, true);
});

Deno.test("acpApprover returns false when outcome selects reject", async () => {
  const { conn } = fakeConn({ outcome: "selected", optionId: "reject" });
  const approved = await acpApprover(conn, "sess-1")(SCRIPT, ["allow-read=."]);
  assertEquals(approved, false);
});

Deno.test("acpApprover returns false when outcome is cancelled", async () => {
  const { conn } = fakeConn({ outcome: "cancelled" });
  const approved = await acpApprover(conn, "sess-1")(SCRIPT, []);
  assertEquals(approved, false);
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
