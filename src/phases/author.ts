import { chat } from "../provider/ollama.ts";
import { handleWrite, writeToolDef } from "../tools/write.ts";
import { logToMessages } from "./messages.ts";
import { readInput, writeOutput } from "./ipc.ts";
import type { Entry } from "../log/schema.ts";

// Author phase entrypoint. Launched with `--allow-net=<ollama>` ONLY —
// it has NO filesystem access at all. It proposes one script via the
// `write` tool; the proposal goes to the log for human review. The agent
// cannot execute anything.

const SYSTEM =
  "You are pagu's Author phase. Using the conversation and observations, " +
  "write ONE Deno TypeScript script that accomplishes the user's task. " +
  'Call the `write` tool exactly once with { lang: "ts", body }. The ' +
  "script will be reviewed by a human and run in a sandbox — you cannot " +
  "run it. Use least privilege: touch only what's necessary.";

const input = await readInput();
const messages = logToMessages(input.log, SYSTEM);
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
