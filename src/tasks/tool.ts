// pure
import type { ToolDef } from "../providers/chat.ts";
import type { CommandInvocationEntry } from "../log/schema.ts";
import type { CommandRule } from "./grammar.ts";
/** Subset of DiscoveredTask sufficient for the tool listing. */
type TaskListing = { program: string; args: string[]; description: string };

/**
 * The `run_task` tool. The agent passes the exact command string; the
 * orchestrator parses it, validates against the command policy, cages,
 * and runs without a human prompt.
 *
 * Single-string interface matches the listed commands exactly — no
 * separate program/args split for the model to get wrong.
 */
export function runTaskToolDef(tasks: TaskListing[]): ToolDef {
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

/** One rule's usage line for the tool description, e.g.
 * `rg [-i --ignore-case -n …] <pattern> [paths]`. */
function ruleUsage(r: CommandRule): string {
  const head = [r.program, ...r.prefix].join(" ");
  const flags = r.flags.map((f) => f.name).join(" ");
  return flags ? `${head} [${flags}] + positionals` : head;
}

/**
 * The `run_command` tool. Read-only commands (search/inspect) the agent may run
 * with **validated free args** — auto-approved, no writes/network. Args are
 * passed as separate argv tokens (no shell), and validated by the command
 * grammar before running; bad args come back with a reason.
 */
export function runCommandToolDef(rules: CommandRule[]): ToolDef {
  const programs = [...new Set(rules.map((r) => r.program))];
  const usage = rules.map(ruleUsage).join("; ");
  return {
    name: "run_command",
    description:
      `Run a read-only command to search or inspect the project (auto-approved; ` +
      `no writes, no network). Pass each flag, value, and path as a separate ` +
      `args element (no shell). Available: ${usage}.`,
    parameters: {
      type: "object",
      properties: {
        program: {
          type: "string",
          enum: programs,
          description: "the program to run",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description:
            "argv tokens — each flag, value, and path a separate element",
        },
      },
      required: ["program", "args"],
    },
  };
}

export function handleRunCommand(
  toolArgs: Record<string, unknown>,
  id: string,
): CommandInvocationEntry {
  const program = String(toolArgs.program ?? "");
  const args = Array.isArray(toolArgs.args) ? toolArgs.args.map(String) : [];
  return { kind: "command-invoke", id, program, args };
}
