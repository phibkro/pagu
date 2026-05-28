// effects: run_task / run_command execution pipelines.
import {
  absolutizePerm,
  parsePermission,
  withinEnvelope,
} from "../permissions/index.ts";
import {
  autoApprove,
  cageOnce,
  type Exec,
  run,
  runHandlerStep,
} from "../capability/index.ts";
import { pipeline } from "../loop.ts";
import {
  filterStaleInferred,
  loadInferred,
  matchesPolicy,
  storeInferred,
} from "./policy.ts";
import { findDefaultRule } from "./defaults.ts";
import { type CommandRule, recognize } from "./grammar.ts";
import type { AgentContext, CommandInvocationEntry } from "../context.ts";

/** The runner body for a command invocation — orchestrator-generated, never
 * authored by the agent (invariant #1). */
function commandBody(program: string, args: string[]): string {
  return `const r = await new Deno.Command(${JSON.stringify(program)}, {
  args: ${JSON.stringify(args)},
  cwd: Deno.cwd(),
  stdout: "inherit",
  stderr: "inherit",
}).output();
Deno.exit(r.code);
`;
}

/**
 * read-only command path: args validated by grammar, fixed read-only ceiling,
 * no cage. pipeline([grammarGate, autoApprove, run]).
 */
async function runWithDefaultRule(
  entry: CommandInvocationEntry,
  ctx: AgentContext,
  rule: CommandRule,
): Promise<"stop" | "loop"> {
  const exec: Exec = {
    ctx,
    id: entry.id,
    title: `${entry.program} ${entry.args.join(" ")}`,
    body: "",
    perms: [],
    rationale: `read-only command: ${entry.program} ${entry.args.join(" ")}`,
    cwd: ctx.repo ?? ctx.projectBase,
    outcome: "loop",
  };

  const grammarGate = (e: Exec) => {
    const rec = recognize(
      rule,
      entry.args,
      ctx.readPaths,
      ctx.repo ?? ctx.projectBase,
    );
    if (!rec.ok) {
      const cmd = `${entry.program} ${entry.args.join(" ")}`;
      ctx.ui.show(`✗ run_command: "${cmd}" — ${rec.reason}`);
      ctx.log.push({
        kind: "message",
        role: "user",
        text: `run_command rejected: ${rec.reason}. Fix the arguments and ` +
          `try again, or use the write tool.`,
      });
      ctx.persist();
      return Promise.resolve("done" as const);
    }
    e.body = commandBody(entry.program, entry.args);
    e.perms = [
      ...ctx.readPaths.map((p) => `allow-read=${p}`),
      `allow-run=${entry.program}`,
    ];
    return Promise.resolve("continue" as const);
  };

  const handlers = ctx.activeHandlers.map((h) => runHandlerStep(h, ctx));
  await pipeline([grammarGate, ...handlers, autoApprove, run])(exec);
  return exec.outcome;
}

/**
 * run_task path: policy check → cage (infer or ceiling-check) → autoApprove → run.
 * pipeline([policyGate, taskCeilingGate, autoApprove, run]).
 */
async function runWithPolicy(
  entry: CommandInvocationEntry,
  ctx: AgentContext,
): Promise<"stop" | "loop"> {
  const base = ctx.repo ?? Deno.cwd();
  const body = commandBody(entry.program, entry.args);

  // Load inferred once; both policyGate and taskCeilingGate close over it.
  const inferred = await (async () => {
    try {
      return await filterStaleInferred(await loadInferred(ctx.projectBase));
    } catch {
      return [];
    }
  })();
  const allEntries = [...ctx.commandEntries, ...inferred];

  const exec: Exec = {
    ctx,
    id: entry.id,
    title: `${entry.program} ${entry.args.join(" ")}`,
    body,
    perms: [],
    rationale: `auto-approved command: ${entry.program} ${
      entry.args.join(" ")
    }`,
    cwd: ctx.repo ?? ctx.projectBase,
    outcome: "loop",
  };

  const policyGate = (_e: Exec) => {
    const match = matchesPolicy(entry.program, entry.args, allEntries);
    if (!match) {
      const cmd = `${entry.program} ${entry.args.join(" ")}`;
      ctx.ui.show(`✗ run_task: "${cmd}" is not in the command policy`);
      ctx.log.push({
        kind: "message",
        role: "user",
        text: `run_task rejected: "${cmd}" is not in the allowed-tasks list. ` +
          `Use the write tool to propose a script instead.`,
      });
      ctx.persist();
      return Promise.resolve("done" as const);
    }
    return Promise.resolve("continue" as const);
  };

  const taskCeilingGate = async (e: Exec) => {
    const policyEntry = matchesPolicy(entry.program, entry.args, allEntries)!;
    const hasCeiling = policyEntry.permissions.length > 0;

    ctx.ui.status(`caging command: ${entry.program} ${entry.args.join(" ")}…`);
    const cls = await cageOnce({
      body: e.body,
      id: entry.id,
      ctx,
      extraPerms: hasCeiling ? policyEntry.permissions : [],
      cwd: ctx.repo ?? ctx.projectBase,
    });

    if (cls.kind === "ok") {
      // Grant the full declared ceiling when one exists (explicit policy
      // commitment); otherwise readPaths only.
      e.perms = hasCeiling
        ? [
          ...ctx.readPaths.map((p) => `allow-read=${p}`),
          ...policyEntry.permissions,
        ]
        : ctx.readPaths.map((p) => `allow-read=${p}`);
      return "continue" as const;
    }

    if (cls.kind === "needs-perms") {
      const discovered = cls.perms.map((s) =>
        parsePermission(absolutizePerm(s, base))
      );
      if (hasCeiling) {
        const ceiling = policyEntry.permissions.flatMap((p) => {
          try {
            return [parsePermission(p)];
          } catch {
            return [];
          }
        });
        if (!withinEnvelope(discovered, { allow: ceiling })) {
          ctx.ui.show(
            `✗ command "${entry.program} ${
              entry.args.join(" ")
            }" needs perms outside stored ceiling`,
          );
          ctx.log.push({
            kind: "decision",
            script: entry.id,
            verdict: "reject",
            rationale: "discovered perms exceed stored ceiling",
          });
          ctx.persist();
          e.outcome = "stop";
          return "done" as const;
        }
      } else {
        // First-run: infer and store the permission ceiling.
        const sourceFile = ctx.discoveredTasks.find(
          (t) =>
            t.program === entry.program &&
            t.args.length === entry.args.length &&
            t.args.every((a, i) => a === entry.args[i]),
        )?.sourceFile;
        await storeInferred(ctx.projectBase, {
          program: entry.program,
          args: entry.args,
          permissions: cls.perms.map((s) => absolutizePerm(s, base)),
          source: "inferred",
          inferredAt: new Date().toISOString(),
          sourceFile,
        });
      }
      e.perms = [
        ...ctx.readPaths.map((p) => `allow-read=${p}`),
        ...cls.perms.map((s) => absolutizePerm(s, base)),
      ];
      return "continue" as const;
    }

    // bug
    ctx.ui.show(`✗ command cage failed:\n${cls.error}`);
    ctx.log.push({
      kind: "decision",
      script: entry.id,
      verdict: "reject",
      rationale: `cage bug: ${cls.error}`,
    });
    ctx.persist();
    e.outcome = "stop";
    return "done" as const;
  };

  const handlers = ctx.activeHandlers.map((h) => runHandlerStep(h, ctx));
  await pipeline([policyGate, taskCeilingGate, ...handlers, autoApprove, run])(
    exec,
  );
  return exec.outcome;
}

/** Return "stop" to exit runTask, "loop" to continue to the next turn. */
export function executeCommandInvocation(
  entry: CommandInvocationEntry,
  ctx: AgentContext,
): Promise<"stop" | "loop"> {
  const defaultRule = findDefaultRule(entry.program, entry.args);
  if (defaultRule) return runWithDefaultRule(entry, ctx, defaultRule);
  return runWithPolicy(entry, ctx);
}
