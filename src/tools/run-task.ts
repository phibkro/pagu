// pure
import type { ToolDef } from "../provider/chat.ts";
import type { CommandInvocationEntry } from "../log/schema.ts";
import type { DiscoveredTask } from "../command-policy.ts";

/**
 * The `run_task` tool. The agent names a pre-approved project task; the
 * orchestrator validates against the command policy, cages to discover or
 * verify the permission ceiling, then runs without a human prompt.
 *
 * Deny by default: only tasks in the command policy (explicit allowlist or
 * inferred from a previous cage run) can be invoked. Everything else requires
 * `write` + full human review.
 */
export function runTaskToolDef(tasks: DiscoveredTask[]): ToolDef {
  const list = tasks.length > 0
    ? " Available: " +
      tasks
        .map((t) => `\`${t.program} ${t.args.join(" ")}\` (${t.description})`)
        .join("; ") +
      "."
    : "";
  return {
    name: "run_task",
    description:
      `Run a pre-approved project task or allowed command. Only tasks in the command policy are available — anything else requires the write tool.${list}`,
    parameters: {
      type: "object",
      properties: {
        program: {
          type: "string",
          description: 'The program to run (e.g. "deno", "npm", "just").',
        },
        args: {
          type: "array",
          items: { type: "string" },
          description:
            'Arguments for the program (e.g. ["task", "lint"] for `deno task lint`).',
        },
      },
      required: ["program", "args"],
    },
  };
}

export function handleRunTask(
  toolArgs: Record<string, unknown>,
  id: string,
): CommandInvocationEntry {
  const program = String(toolArgs.program ?? "");
  const args = Array.isArray(toolArgs.args) ? toolArgs.args.map(String) : [];
  return { kind: "command-invoke", id, program, args };
}
