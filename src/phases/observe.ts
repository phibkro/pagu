// effects: phase entrypoint (stdin -> model -> stdout)
import { chat, type ChatMessage } from "../provider/chat.ts";
import { handleRead, readToolDef } from "../tools/read.ts";
import { logToMessages, withAgents } from "./messages.ts";
import { readInput, writeOutput } from "./ipc.ts";
import type { Entry } from "../log/schema.ts";

// Observe phase entrypoint. Launched with `--allow-net=<ollama>` and
// `--allow-read=<allowlist>` only — it can read allowlisted files and
// talk to the model, nothing else. Reads context with the `read` tool,
// then stops; emits the observations + a closing summary message.

const SYSTEM =
  "You are pagu's Observe phase. Use the `read` tool to gather only the " +
  "context needed to plan a script for the user's task. Read as little as " +
  "possible. When you have enough, reply with a one-line summary and stop " +
  "calling read.";

const MAX_ROUNDS = 5;

const input = await readInput();
const messages = logToMessages(
  input.log,
  withAgents(SYSTEM, input.agents),
);
const out: Entry[] = [];

for (let round = 0; round < MAX_ROUNDS; round++) {
  const res = await chat(input.provider, messages, [readToolDef]);
  if (res.toolCalls.length === 0) {
    if (res.content) {
      out.push({ kind: "message", role: "assistant", text: res.content });
    }
    break;
  }
  messages.push({ role: "assistant", content: res.content });
  for (const call of res.toolCalls) {
    if (call.name !== "read") continue;
    try {
      const obs = await handleRead(call.args);
      out.push(obs);
      messages.push(
        {
          role: "tool" as const,
          content: `[${obs.source}]\n${obs.content}`,
        } satisfies ChatMessage,
      );
    } catch (err) {
      const msg = `read failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      out.push({ kind: "observation", source: "error", content: msg });
      messages.push({ role: "tool", content: msg });
    }
  }
}

writeOutput(out);
