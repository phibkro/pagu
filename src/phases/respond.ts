// effects: phase entrypoint (reads allowlist, talks to model, emits chat/script)
import { chat, type ChatMessage } from "../provider/chat.ts";
import { handleRead, readToolDef } from "../tools/read.ts";
import { handleWrite, writeToolDef } from "../tools/write.ts";
import { logToMessages, withAgents } from "./messages.ts";
import { readInput, writeOutput } from "./ipc.ts";
import type { Entry } from "../log/schema.ts";

// The single agent phase. The model converses; it calls `read` to inspect
// files and `write` to propose a script ONLY when an action is needed.
// Returns when it replies in text (a chat turn) or proposes a script.
// Reads are handled here (this process has read+net); scripts are handed
// to the orchestrator for human review + sandboxed run.

const DENO_NOTES =
  "When you DO write a script, use ONLY Deno built-ins — no `import` " +
  "statements, no npm:, no URLs. Notes: Deno.readDir(path) is an ASYNC " +
  "ITERABLE (no .filter/.map) — `for await (const e of Deno.readDir(p)) {}`; " +
  "await Deno.readTextFile/writeTextFile/stat; await Deno.mkdir(p,{recursive:" +
  "true}). Prefer absolute paths from the task; cwd is a scratch dir.";

const SYSTEM =
  "You are pagu, a local assistant the user drives from a terminal. " +
  "Converse normally and answer questions directly. Use the `read` tool to " +
  "inspect files or directories when it helps. When accomplishing the task " +
  "requires changing the system, creating/editing files, or running code, " +
  "propose a Deno TypeScript script with the `write` tool — it is reviewed " +
  "by a human and run in a sandbox; you cannot run it yourself. If you can " +
  "answer or finish without acting, just reply — only write a script when an " +
  "action is genuinely needed.\n\n" + DENO_NOTES;

const MAX_READS = 6;

// Stream content tokens to stderr as a live display side-channel; the
// orchestrator forwards them to the user's terminal. stdout stays reserved
// for the structured entries this phase returns.
const enc = new TextEncoder();
const onToken = (t: string) => Deno.stderr.writeSync(enc.encode(t));

const input = await readInput();
const messages = logToMessages(input.log, withAgents(SYSTEM, input.agents));
const out: Entry[] = [];

for (let i = 0; i <= MAX_READS; i++) {
  const res = await chat(
    input.provider,
    messages,
    [readToolDef, writeToolDef],
    onToken,
  );

  const writeCall = res.toolCalls.find((c) => c.name === "write");
  if (writeCall) {
    if (res.content) {
      out.push({ kind: "message", role: "assistant", text: res.content });
    }
    const n = input.log.filter((e) => e.kind === "script").length + 1;
    out.push(handleWrite(writeCall.args, `s${n}`));
    break;
  }

  const readCalls = res.toolCalls.filter((c) => c.name === "read");
  if (readCalls.length === 0) {
    // Pure chat reply — no action needed.
    if (res.content) {
      out.push({ kind: "message", role: "assistant", text: res.content });
    }
    break;
  }

  // Execute reads, feed results back, and continue deciding. The read
  // result is logged as an observation; also announce the action live on
  // the stderr side-channel so the user sees what the agent inspected.
  if (res.content) messages.push({ role: "assistant", content: res.content });
  for (const call of readCalls) {
    const path = String(call.args.path ?? "");
    try {
      const obs = await handleRead(call.args);
      onToken(`\n· ${obs.source}\n`); // e.g. "· ls src" / "· read README.md"
      out.push(obs);
      messages.push(
        {
          role: "tool",
          content: `[${obs.source}]\n${obs.content}`,
        } as ChatMessage,
      );
    } catch (err) {
      onToken(`\n· read ${path} (denied)\n`);
      const msg = `read failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      out.push({ kind: "observation", source: "error", content: msg });
      messages.push({ role: "tool", content: msg });
    }
  }
}

writeOutput(out);
