// pure
import type { ChatMessage } from "../providers/chat.ts";
import type { Entry } from "../log/schema.ts";

/** Project the conversation log into chat messages for the model. */
export function logToMessages(log: Entry[], system: string): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "system", content: system }];
  for (const e of log) {
    switch (e.kind) {
      case "message":
        msgs.push({ role: e.role, content: e.text });
        break;
      case "observation":
        msgs.push({ role: "tool", content: `[${e.source}]\n${e.content}` });
        break;
      case "script":
        msgs.push({
          role: "assistant",
          content: `Proposed script ${e.id} (${e.lang}):\n${e.body}`,
        });
        break;
      case "decision":
        msgs.push({
          role: "user",
          content: `Decision on ${e.script}: ${e.verdict}. ${e.rationale}`,
        });
        break;
      case "result":
        msgs.push({
          role: "tool",
          content: `[result of ${e.script}, exit ${e.exit}]\n${e.output}`,
        });
        break;
      case "perms":
        break;
    }
  }
  return msgs;
}

/** Compose a phase's system prompt with the AGENTS.md instructions. */
export function withAgents(system: string, agents?: string): string {
  return agents
    ? `${system}\n\nAgent instructions (AGENTS.md):\n${agents}`
    : system;
}
