// effects: stdio (stdin/stdout); pure: validatePhaseInput
import { z } from "zod";
import type { Entry } from "../log/schema.ts";
import type { ProviderConfig, Usage } from "../providers/chat.ts";
import type { CommandRule } from "../tasks/grammar.ts";
import type { ConcealmentSpec } from "../permissions/concealment.ts";

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
  /** The concealment spec — the agent's read tool refuses any path
   * buildConcealment(conceal).conceals(p) returns true for. Deno --deny-read
   * breaks readDir of the parent, so the read-refusal is enforced at the
   * application layer here (the OS-sandbox mask is the runner-side wall). */
  conceal?: ConcealmentSpec;
}

// The PhaseInput contract at the process boundary. Shallow on `log` (the log
// codec owns entry shape; deep-validating the union here would duplicate it and
// the orchestrator is the trusted producer) and on the complex list fields —
// the point is to catch an orchestrator bug, not re-type the whole payload.
const stringArray = z.array(z.string());
const phaseInputSchema = z.object({
  log: z.array(z.unknown()),
  provider: z.object({
    model: z.string(),
    baseURL: z.string(),
    apiKey: z.string().optional(),
    format: z.enum(["openai", "anthropic"]).optional(),
  }),
  agents: z.string().optional(),
  capabilities: z.string().optional(),
  skillScripts: z.array(z.unknown()).optional(),
  allowedTasks: z.array(z.unknown()).optional(),
  commandRules: z.array(z.unknown()).optional(),
  conceal: z.object({
    vcsPaths: stringArray,
    hideGlobs: stringArray,
    secretGlobs: stringArray,
    revealGlobs: stringArray,
    roots: stringArray,
    enumerated: stringArray,
  }).optional(),
});

/** Validate a parsed object against the PhaseInput contract — fail loud (a
 * `ZodError` naming the offending field) so an orchestrator bug surfaces here,
 * at the boundary, not three frames deep. Returns the input typed. */
export function validatePhaseInput(parsed: unknown): PhaseInput {
  phaseInputSchema.parse(parsed);
  return parsed as PhaseInput;
}

/** Read+parse the PhaseInput a parent piped to this phase's stdin. */
export async function readInput(): Promise<PhaseInput> {
  const text = await new Response(Deno.stdin.readable).text();
  return validatePhaseInput(JSON.parse(text));
}

/** Emit the entries this phase produced (parent appends them to the log) plus
 * the turn's token usage when the provider reported it (the parent accumulates
 * a session total + drives the HUD; usage carries no capability). */
export function writeOutput(entries: Entry[], usage?: Usage): void {
  console.log(JSON.stringify({ entries, usage }));
}
