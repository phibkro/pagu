import { chat } from "../provider/chat.ts";
import { handleWrite, writeToolDef } from "../tools/write.ts";
import { logToMessages } from "./messages.ts";
import { readInput, withAgents, writeOutput } from "./ipc.ts";
import type { Entry } from "../log/schema.ts";

// Author phase entrypoint. Launched with `--allow-net=<ollama>` ONLY —
// it has NO filesystem access at all. It proposes one script via the
// `write` tool; the proposal goes to the log for human review. The agent
// cannot execute anything.

const DENO_NOTES =
  "Deno API notes (use ONLY built-ins — no remote imports, no npm:, no URLs):\n" +
  "- Do NOT write ANY `import` statements. Everything you need is already " +
  "on the global `Deno` object.\n" +
  "- Deno.readDir(path) returns an ASYNC ITERABLE, not an array; it has NO " +
  ".filter/.map. Iterate: `for await (const e of Deno.readDir(path)) { " +
  "/* e.name, e.isFile, e.isDirectory */ }`.\n" +
  "- await Deno.readTextFile(path) -> string; await Deno.writeTextFile(path, " +
  "str); await Deno.stat(path) -> { isFile, isDirectory, size }.\n" +
  "- await Deno.mkdir(path, { recursive: true }); await Deno.remove(path, { " +
  "recursive: true }).\n" +
  "- Prefer the absolute paths given in the task. cwd is a scratch dir.";

const SYSTEM =
  "You are pagu's Author phase. Using the conversation and observations, " +
  "write ONE Deno TypeScript script that accomplishes the user's task. " +
  'Call the `write` tool exactly once with { lang: "ts", body }. The ' +
  "script will be reviewed by a human and run in a sandbox — you cannot " +
  "run it. Use least privilege: touch only what's necessary. If a prior " +
  "attempt failed in the sandbox, fix the reported error.\n\n" +
  DENO_NOTES;

const input = await readInput();
const messages = logToMessages(
  input.log,
  withAgents(SYSTEM, input.agents),
);
const res = await chat(input.provider, messages, [writeToolDef]);

const out: Entry[] = [];
const call = res.toolCalls.find((c) => c.name === "write");
if (call) {
  const n = input.log.filter((e) => e.kind === "script").length + 1;
  out.push(handleWrite(call.args, `s${n}`));
} else if (res.content) {
  out.push({ kind: "message", role: "assistant", text: res.content });
}

writeOutput(out);
