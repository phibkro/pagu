// pure: runCommandCapability + runTaskCapability — two separate Capability<Data>
// objects sharing entryKind "command-invoke" (same semantic action type, same
// executor; see the entryKind=executor-key law in the design spec).
import { type Capability } from "../capability/index.ts";
import { executeCommandInvocation } from "./execute.ts";
import {
  handleRunCommand,
  handleRunTask,
  runCommandToolDef,
  runTaskToolDef,
} from "./tool.ts";
import type { CommandRule } from "./grammar.ts";
import { type CommandInvocationEntry } from "../context.ts";
import type { Entry } from "../log/index.ts";
import type { AgentContext } from "../context.ts";

type TaskListing = { program: string; args: string[]; description: string };

/** Builds the allowed-tasks listing for runTaskCapability.data.
 * Moved here from agent.ts; also still imported by agent.ts during migration. */
export function buildAllowedTasks(ctx: AgentContext): TaskListing[] {
  const inPolicy = (p: string, a: string[]) =>
    ctx.commandEntries.some(
      (e) =>
        e.program === p &&
        e.args.length === a.length &&
        e.args.every((x, i) => x === a[i]),
    );
  return [
    ...ctx.discoveredTasks.filter((t) => inPolicy(t.program, t.args)),
    ...ctx.commandEntries
      .filter((e) =>
        e.source === "explicit" &&
        !ctx.discoveredTasks.some(
          (t) =>
            t.program === e.program &&
            t.args.length === e.args.length &&
            t.args.every((a, i) => a === e.args[i]),
        )
      )
      .map((e) => ({
        program: e.program,
        args: e.args,
        description: `${e.program} ${e.args.join(" ")}`,
      })),
  ];
}

export const runCommandCapability = {
  entryKind: "command-invoke",
  toolName: "run_command",
  idPrefix: "ci",
  data: (ctx: AgentContext): CommandRule[] => ctx.availableCommandRules,
  isAvailable: (data: CommandRule[]): boolean => data.length > 0,
  toolDef: (data: CommandRule[]) => runCommandToolDef(data),
  toEntry: (args: Record<string, unknown>, id: string): Entry =>
    handleRunCommand(args, id),
  execute: (entry: Entry, ctx: AgentContext) =>
    executeCommandInvocation(entry as CommandInvocationEntry, ctx),
} satisfies Capability<CommandRule[]>;

export const runTaskCapability = {
  entryKind: "command-invoke",
  toolName: "run_task",
  idPrefix: "ci",
  data: (ctx: AgentContext): TaskListing[] => buildAllowedTasks(ctx),
  isAvailable: (data: TaskListing[]): boolean => data.length > 0,
  toolDef: (data: TaskListing[]) => runTaskToolDef(data),
  toEntry: (args: Record<string, unknown>, id: string): Entry =>
    handleRunTask(args, id),
  execute: (entry: Entry, ctx: AgentContext) =>
    executeCommandInvocation(entry as CommandInvocationEntry, ctx),
} satisfies Capability<TaskListing[]>;
