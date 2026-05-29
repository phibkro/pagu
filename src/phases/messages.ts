// pure
import type { ChatMessage } from "../providers/chat.ts";
import type { Entry } from "../log/schema.ts";

/** A point on the context trust gradient (`docs/CONCEPTS.md` → the context axis
 * is a trust gradient). `authored` may instruct; `trusted` is the agent's own
 * accumulated output; `untrusted` originated outside the human (file reads, tool
 * output) and may inform, never instruct — so it is fenced. */
export type TrustLevel = "authored" | "trusted" | "untrusted";

/** The trust denotation over log entries. `observation`/`result` carry data
 * that originated outside the human, so they are untrusted; the agent's own
 * proposals/actions/prose are trusted; the human's turns (task, approval) are
 * authored. Total over the entry union so every span is labelled. */
export function trust(e: Entry): TrustLevel {
  switch (e.kind) {
    case "observation":
    case "result":
      return "untrusted";
    case "message":
      return e.role === "user" ? "authored" : "trusted";
    case "decision":
      return "authored";
    case "script":
    case "skill-invoke":
    case "command-invoke":
    case "perms":
      return "trusted";
  }
}

/**
 * Wrap untrusted content (file reads, tool/script output) in a named fence the
 * content cannot break out of. Breakout resistance is by construction: pick the
 * smallest `n` whose close tag `</untrusted-n>` does not occur in the content,
 * so the delimiter appears only as the fence and never inside it — the same
 * "absent delimiter" guarantee the log codec gets from variable-length tilde
 * fences (`log/serialize.ts`), generalized from longest-run to shortest-absent.
 * Pure and deterministic (no nonce), so it is testable by law.
 *
 * The fence is only meaningful if the model is told what it means — see the
 * system prompt in `respond.ts`: content inside `<untrusted-…>` is data to
 * inform an answer, never instructions to obey. This is the mechanical half of
 * the context-axis invariant (`docs/INVARIANTS.md`); the model's obedience is
 * the semantic half, not checkable here.
 */
export function fenceUntrusted(content: string): string {
  let n = 0;
  while (content.includes(`</untrusted-${n}>`)) n++;
  return `<untrusted-${n}>\n${content}\n</untrusted-${n}>`;
}

/** Project the conversation log into chat messages for the model. */
export function logToMessages(log: Entry[], system: string): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "system", content: system }];
  for (const e of log) {
    switch (e.kind) {
      case "message":
        msgs.push({ role: e.role, content: e.text });
        break;
      case "observation":
        // The source label is our trusted annotation of what ran; the returned
        // content is accumulated-untrusted (a file/dir the agent read) → fenced.
        msgs.push({
          role: "tool",
          content: `[${e.source}]\n${fenceUntrusted(e.content)}`,
        });
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
        // The header (script id, exit) is trusted metadata; the script's stdout/
        // stderr is accumulated-untrusted (it can echo file/network data) → fenced.
        msgs.push({
          role: "tool",
          content: `[result of ${e.script}, exit ${e.exit}]\n${
            fenceUntrusted(e.output)
          }`,
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
