// effects: stdio (stdin/stdout)
import type { Entry } from "../log/schema.ts";
import type { ProviderConfig } from "../providers/chat.ts";
import type { CommandRule } from "../tasks/grammar.ts";

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
  /** Active skill scripts available for invoke_skill tool calls.
   * Only name and description are sent — the orchestrator owns the bodies. */
  skillScripts?: Array<{ name: string; description: string }>;
  /** Tasks available for run_task: union of allowed + discovered tasks. */
  allowedTasks?: Array<
    { program: string; args: string[]; description: string }
  >;
  /** Read-only command rules available for run_command (installed here). */
  commandRules?: CommandRule[];
  /** Gitignored paths the agent must not read. Deno --deny-read breaks
   * readDir of the parent, so we enforce this at the application layer
   * in respond.ts instead of via a Deno flag. Absolute paths. */
  gitignored?: string[];
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
