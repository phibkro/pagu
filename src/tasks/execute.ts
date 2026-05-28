// effects: policy check + cage + inferred-perms storage + run for run_task
import {
  absolutizePerm,
  parsePermission,
  withinEnvelope,
} from "../permissions/index.ts";
import { classifyRun, runScript } from "../runner/index.ts";
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
 * authored by the agent (invariant #1). Runs the program with the given args. */
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
 * A read-only command (a default-rule match): args validated by the grammar,
 * then run with a FIXED read-only ceiling — `allow-read=<scope>` + the program,
 * no write, no net. The declared ceiling needs no cage discovery; the
 * permission floor + OS sandbox bound what's possible if a flag was mis-vetted.
 */
async function runReadOnlyCommand(
  entry: CommandInvocationEntry,
  ctx: AgentContext,
  rule: CommandRule,
): Promise<"stop" | "loop"> {
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
    return "loop";
  }

  ctx.log.push({
    kind: "decision",
    script: entry.id,
    verdict: "approve",
    rationale: `read-only command: ${entry.program} ${entry.args.join(" ")}`,
  });
  ctx.persist();
  ctx.ui.status(`running: ${entry.program} ${entry.args.join(" ")}…`);

  const scratch = await Deno.makeTempDir({ prefix: "pagu-run-" });
  const file = `${scratch}/${entry.id}.ts`;
  await Deno.writeTextFile(file, commandBody(entry.program, entry.args));
  const result = await runScript({
    scriptPath: file,
    perms: [
      ...ctx.readPaths.map((p) => `allow-read=${p}`),
      `allow-run=${entry.program}`,
      ...ctx.denyFlags,
    ],
    cwd: ctx.repo ?? ctx.projectBase,
    sandbox: ctx.sandboxKind,
  });
  await Deno.remove(scratch, { recursive: true });

  const output = result.stdout || result.stderr;
  const resultEntry = {
    kind: "result" as const,
    script: entry.id,
    exit: result.exit,
    ranWith: result.ranWith,
    output,
  };
  ctx.log.push(resultEntry);
  ctx.persist();
  ctx.ui.entries?.([resultEntry]);
  ctx.ui.show(`\n--- result (exit ${result.exit}) ---\n${output}`);
  return "loop";
}

/** Return "stop" to exit runTask, "loop" to continue to the next turn. */
export async function executeCommandInvocation(
  entry: CommandInvocationEntry,
  ctx: AgentContext,
): Promise<"stop" | "loop"> {
  // A built-in read-only command (free-arg grammar) takes the validated,
  // fixed-ceiling path — no policy lookup or cage discovery.
  const defaultRule = findDefaultRule(entry.program, entry.args);
  if (defaultRule) return runReadOnlyCommand(entry, ctx, defaultRule);

  // Merge explicit entries with stale-filtered inferred ceiling
  const inferred = await (async () => {
    try {
      return await filterStaleInferred(await loadInferred(ctx.projectBase));
    } catch {
      return [];
    }
  })();
  const allEntries = [...ctx.commandEntries, ...inferred];
  const policyEntry = matchesPolicy(entry.program, entry.args, allEntries);

  if (!policyEntry) {
    const cmd = `${entry.program} ${entry.args.join(" ")}`;
    ctx.ui.show(`✗ run_task: "${cmd}" is not in the command policy`);
    ctx.log.push({
      kind: "message",
      role: "user",
      text: `run_task rejected: "${cmd}" is not in the allowed-tasks list. ` +
        `Use the write tool to propose a script instead.`,
    });
    ctx.persist();
    return "loop";
  }

  // The orchestrator generates the script body — agent never authors it.
  const cmdBody = `const r = await new Deno.Command(${
    JSON.stringify(entry.program)
  }, {
  args: ${JSON.stringify(entry.args)},
  cwd: Deno.cwd(),
  stdout: "inherit",
  stderr: "inherit",
}).output();
Deno.exit(r.code);
`;
  const base = ctx.repo ?? Deno.cwd();

  ctx.ui.status(`caging command: ${entry.program} ${entry.args.join(" ")}…`);
  const scratch = await Deno.makeTempDir({ prefix: "pagu-cage-" });
  const file = `${scratch}/${entry.id}.ts`;
  await Deno.writeTextFile(file, cmdBody);

  const hasCeiling = policyEntry.permissions.length > 0;
  const cageResult = await runScript({
    scriptPath: file,
    perms: [
      ...ctx.readPaths.map((p) => `allow-read=${p}`),
      `allow-write=${scratch}`,
      ...(hasCeiling ? policyEntry.permissions : []),
      ...ctx.denyFlags,
    ],
    cwd: ctx.repo ?? ctx.projectBase,
    sandbox: ctx.sandboxKind,
  });
  await Deno.remove(scratch, { recursive: true });

  const cls = classifyRun(cageResult.exit, cageResult.stderr);
  let cmdPerms: string[];

  if (cls.kind === "ok") {
    cmdPerms = hasCeiling
      ? [
        ...ctx.readPaths.map((p) => `allow-read=${p}`),
        ...policyEntry.permissions,
      ]
      : ctx.readPaths.map((p) => `allow-read=${p}`);
  } else if (cls.kind === "needs-perms") {
    const discovered = cls.perms.map((s) =>
      parsePermission(absolutizePerm(s, base))
    );
    if (policyEntry.permissions.length > 0) {
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
        return "stop";
      }
    } else {
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
    cmdPerms = [
      ...ctx.readPaths.map((p) => `allow-read=${p}`),
      ...cls.perms.map((s) => absolutizePerm(s, base)),
    ];
  } else {
    ctx.ui.show(`✗ command cage failed:\n${cls.error}`);
    ctx.log.push({
      kind: "decision",
      script: entry.id,
      verdict: "reject",
      rationale: `cage bug: ${cls.error}`,
    });
    ctx.persist();
    return "stop";
  }

  ctx.ui.status(
    `running: ${entry.program} ${entry.args.join(" ")}…`,
  );
  ctx.log.push({
    kind: "decision",
    script: entry.id,
    verdict: "approve",
    rationale: `auto-approved command: ${entry.program} ${
      entry.args.join(" ")
    }`,
  });
  ctx.persist();

  const runScratch = await Deno.makeTempDir({ prefix: "pagu-run-" });
  const runFile = `${runScratch}/${entry.id}.ts`;
  await Deno.writeTextFile(runFile, cmdBody);
  const result = await runScript({
    scriptPath: runFile,
    perms: [...cmdPerms, ...ctx.denyFlags],
    cwd: ctx.repo ?? ctx.projectBase,
    sandbox: ctx.sandboxKind,
  });
  await Deno.remove(runScratch, { recursive: true });

  const output = result.stdout || result.stderr;
  const resultEntry = {
    kind: "result" as const,
    script: entry.id,
    exit: result.exit,
    ranWith: result.ranWith,
    output,
  };
  ctx.log.push(resultEntry);
  ctx.persist();
  ctx.ui.entries?.([resultEntry]); // surface the tool_call_update
  ctx.ui.show(`\n--- result (exit ${result.exit}) ---\n${output}`);
  if (result.ranWith.some((f) => /--allow-(net|all)\b/.test(f))) {
    ctx.ui.show(
      "\n[net was granted — output would NOT auto-return to the agent]",
    );
    return "stop";
  }
  return "loop";
}
