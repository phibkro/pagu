// effects: stdio (stdin/stdout)
import type { Entry } from "../log/schema.ts";
import type { ProviderConfig } from "../provider/chat.ts";

/** What a phase subprocess receives on stdin. The log carries all prior
 * context (including the user's task as the latest message), so a phase
 * needs no filesystem access to know what to do. */
export interface PhaseInput {
  log: Entry[];
  provider: ProviderConfig;
  /** Merged AGENTS.md instructions (global + project), injected into the
   * phase's system prompt. Empty if none configured. */
  agents?: string;
  /** A description of what the authored scripts can actually do (read
   * scope, write/repo scope), so the agent understands its real reach. */
  capabilities?: string;
}

/** Read+parse the PhaseInput a parent piped to this phase's stdin. */
export async function readInput(): Promise<PhaseInput> {
  const text = await new Response(Deno.stdin.readable).text();
  return JSON.parse(text) as PhaseInput;
}

/** Emit the entries this phase produced (parent appends them to the log). */
export function writeOutput(entries: Entry[]): void {
  console.log(JSON.stringify({ entries }));
}
