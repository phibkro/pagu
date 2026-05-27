import type { ToolDef } from "../provider/chat.ts";
import type { ScriptEntry } from "../log/schema.ts";

/**
 * The `write` tool (Author phase). The model proposes a script; it is NOT
 * executed here. The harness records the returned ScriptEntry in the log;
 * a human reviews and the sandboxed runner executes it later. This is the
 * only "output" capability the agent has, and it produces a proposal, not
 * an action.
 */
export const writeToolDef: ToolDef = {
  name: "write",
  description:
    "Propose a script to accomplish the task. It will be reviewed by a " +
    "human and, if approved, run in a sandbox. You cannot execute it " +
    "yourself.",
  parameters: {
    type: "object",
    properties: {
      lang: { type: "string", description: 'script language, e.g. "ts"' },
      body: { type: "string", description: "the script source" },
    },
    required: ["lang", "body"],
  },
};

export function handleWrite(
  args: Record<string, unknown>,
  id: string,
): ScriptEntry {
  return {
    kind: "script",
    id,
    lang: String(args.lang ?? "ts"),
    body: String(args.body ?? ""),
  };
}
