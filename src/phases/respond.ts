// effects: phase entrypoint (reads allowlist, talks to model, emits chat/script)
import { chat, type ChatMessage } from "../providers/chat.ts";
import { handleRead, readToolDef } from "../read.ts";
import { handleWrite, writeToolDef } from "../write/write.ts";
import { handleInvokeSkill, invokeSkillToolDef } from "../skills/tool.ts";
import { handleRunTask, runTaskToolDef } from "../tasks/tool.ts";
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
  "true}). Prefer absolute paths from the task.";

const SYSTEM =
  "You are pagu, a local assistant the user drives from a terminal. " +
  "Converse normally and answer questions directly. Use the `read` tool to " +
  "inspect files or directories when it helps. When the task needs you to " +
  "change the system — create or edit files, or run code — use the `write` " +
  "tool to author a Deno TypeScript script; it runs on the machine with REAL " +
  "effect, genuinely creating and editing files and running programs. You act " +
  "by writing scripts, so reach for `write` whenever a task calls for doing " +
  "and not only saying. If you can finish without acting, just reply.\n\n" +
  DENO_NOTES;

const MAX_READS = 6;

// Stream content tokens to stderr as a live display side-channel; the
// orchestrator forwards them to the user's terminal. stdout stays reserved
// for the structured entries this phase returns.
const enc = new TextEncoder();
const onToken = (t: string) => Deno.stderr.writeSync(enc.encode(t));

const input = await readInput();
const system = input.capabilities
  ? `${SYSTEM}\n\n${input.capabilities}`
  : SYSTEM;
const messages = logToMessages(input.log, withAgents(system, input.agents));
const out: Entry[] = [];

const skillScripts = input.skillScripts ?? [];
const allowedTasks = input.allowedTasks ?? [];
const gitignored = input.gitignored ?? [];

/** True if path is gitignored (exact match or nested under a gitignored dir). */
function isGitignored(filePath: string): boolean {
  const abs = filePath.startsWith("/") ? filePath : `${Deno.cwd()}/${filePath}`;
  return gitignored.some(
    (g) => abs === g || abs.startsWith(g + "/"),
  );
}
const tools = [
  readToolDef,
  writeToolDef,
  ...(skillScripts.length > 0 ? [invokeSkillToolDef(skillScripts)] : []),
  ...(allowedTasks.length > 0 ? [runTaskToolDef(allowedTasks)] : []),
];

try {
  await converse();
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  // A provider HTTP error (auth/model/billing) is expected operational
  // failure, not a bug: report it as one clean line, no stack.
  if (/^(provider|anthropic) \d+:/.test(msg)) {
    console.error(msg);
    Deno.exit(1);
  }
  throw e; // genuine bug — let it surface with its stack
}
writeOutput(out);

async function converse(): Promise<void> {
  for (let i = 0; i <= MAX_READS; i++) {
    const res = await chat(input.provider, messages, tools, onToken);

    const runTaskCall = res.toolCalls.find((c) => c.name === "run_task");
    if (runTaskCall) {
      if (res.content) {
        out.push({ kind: "message", role: "assistant", text: res.content });
      }
      const n = input.log.filter((e) => e.kind === "command-invoke").length + 1;
      out.push(handleRunTask(runTaskCall.args, `ci${n}`));
      break;
    }

    const invokeCall = res.toolCalls.find((c) => c.name === "invoke_skill");
    if (invokeCall) {
      if (res.content) {
        out.push({ kind: "message", role: "assistant", text: res.content });
      }
      const n = input.log.filter((e) => e.kind === "skill-invoke").length + 1;
      out.push(handleInvokeSkill(invokeCall.args, `sk${n}`));
      break;
    }

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
        if (isGitignored(path)) {
          onToken(`\n· read ${path} (gitignored — access denied)\n`);
          const msg =
            `read denied: ${path} is gitignored. Reading gitignored files ` +
            `is not permitted — they may contain secrets.`;
          out.push({ kind: "observation", source: "error", content: msg });
          messages.push({ role: "tool", content: msg });
        } else {
          const obs = await handleRead(call.args);
          onToken(`\n· ${obs.source}\n`);
          out.push(obs);
          messages.push(
            {
              role: "tool",
              content: `[${obs.source}]\n${obs.content}`,
            } as ChatMessage,
          );
        }
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
}
