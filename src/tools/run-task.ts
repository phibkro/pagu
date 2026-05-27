// pure
import type { ToolDef } from "../provider/chat.ts";
import type { CommandInvocationEntry } from "../log/schema.ts";
import type { DiscoveredTask } from "../command-policy.ts";

/**
 * The `run_task` tool. The agent passes the exact command string; the
 * orchestrator parses it, validates against the command policy, cages,
 * and runs without a human prompt.
 *
 * Single-string interface matches the listed commands exactly — no
 * separate program/args split for the model to get wrong.
 */
export function runTaskToolDef(tasks: DiscoveredTask[]): ToolDef {
  const cmds = tasks.map((t) => `${t.program} ${t.args.join(" ")}`);
  const list = cmds.length > 0
    ? ` Available commands: ${cmds.map((c) => `\`${c}\``).join(", ")}.`
    : "";
  return {
    name: "run_task",
    description:
      `Run a pre-approved project task. Pass the exact command string. Only listed commands are allowed — anything else requires the write tool.${list}`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: cmds,
          description:
            "The exact command to run (must match one of the available commands).",
        },
      },
      required: ["command"],
    },
  };
}

/** Parse "program arg1 arg2 …" into { program, args }. */
export function parseCommand(cmd: string): { program: string; args: string[] } {
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  const [program = "", ...args] = parts;
  return { program, args };
}

export function handleRunTask(
  toolArgs: Record<string, unknown>,
  id: string,
): CommandInvocationEntry {
  const { program, args } = parseCommand(String(toolArgs.command ?? ""));
  return { kind: "command-invoke", id, program, args };
}
