// effects: cage + run for invoke_skill entries
import {
  absolutizePerm,
  parsePermission,
  withinEnvelope,
} from "../permissions/index.ts";
import { classifyRun, runScript } from "../runner/index.ts";
import type { AgentContext, SkillInvocationEntry } from "../context.ts";

/** Return "stop" to exit runTask, "loop" to continue to the next turn. */
export async function executeSkillInvocation(
  entry: SkillInvocationEntry,
  ctx: AgentContext,
): Promise<"stop" | "loop"> {
  const ss = ctx.activeSkillScripts.find((s) => s.name === entry.script);
  if (!ss) {
    ctx.ui.show(`✗ invoke_skill: unknown script "${entry.script}"`);
    ctx.log.push({
      kind: "message",
      role: "user",
      text:
        `invoke_skill failed: no active skill script named "${entry.script}". Available: ${
          ctx.activeSkillScripts.map((s) => s.name).join(", ") || "none"
        }.`,
    });
    ctx.persist();
    return "loop";
  }

  // Re-read from disk: auto-approval claim is "what's currently in the skill
  // file," not a startup snapshot.
  let body: string;
  try {
    body = await Deno.readTextFile(ss.path);
  } catch (e) {
    ctx.ui.show(`✗ skill "${ss.name}": script not readable at ${ss.path}`);
    ctx.log.push({
      kind: "decision",
      script: entry.id,
      verdict: "reject",
      rationale: `skill script unreadable: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
    ctx.persist();
    return "stop";
  }

  ctx.ui.status(`caging skill script: ${ss.name}…`);
  const scratch = await Deno.makeTempDir({ prefix: "pagu-cage-" });
  const file = `${scratch}/${entry.id}.ts`;
  await Deno.writeTextFile(file, body);
  const cageResult = await runScript({
    scriptPath: file,
    perms: [
      ...ctx.readPaths.map((p) => `allow-read=${p}`),
      `allow-write=${scratch}`,
      ...ctx.denyFlags,
    ],
    cwd: ctx.repo ?? scratch,
    sandbox: ctx.sandboxKind,
  });
  await Deno.remove(scratch, { recursive: true });

  const cls = classifyRun(cageResult.exit, cageResult.stderr);
  let skillPerms: string[];
  const base = ctx.repo ?? Deno.cwd();

  if (cls.kind === "ok") {
    skillPerms = ctx.readPaths.map((p) => `allow-read=${p}`);
  } else if (cls.kind === "needs-perms") {
    const discovered = cls.perms.map((s) =>
      parsePermission(absolutizePerm(s, base))
    );
    const ceiling = ss.permissions.flatMap((p) => {
      try {
        return [parsePermission(p)];
      } catch {
        return [];
      }
    });
    if (!withinEnvelope(discovered, { allow: ceiling })) {
      ctx.ui.show(
        `✗ skill "${ss.name}" needs perms outside its declared ceiling — not run`,
      );
      ctx.log.push({
        kind: "decision",
        script: entry.id,
        verdict: "reject",
        rationale: "discovered perms exceed skill ceiling",
      });
      ctx.persist();
      return "stop";
    }
    skillPerms = [
      ...ctx.readPaths.map((p) => `allow-read=${p}`),
      ...cls.perms.map((s) => absolutizePerm(s, base)),
    ];
  } else {
    ctx.ui.show(
      `✗ skill "${ss.name}" failed cage (pre-authored script — not sent back for fixing):\n${cls.error}`,
    );
    ctx.log.push({
      kind: "decision",
      script: entry.id,
      verdict: "reject",
      rationale: `cage bug: ${cls.error}`,
    });
    ctx.persist();
    return "stop";
  }

  ctx.ui.status(`running skill script: ${ss.name}…`);
  ctx.log.push({
    kind: "decision",
    script: entry.id,
    verdict: "approve",
    rationale: `auto-approved skill invocation: ${ss.name}`,
  });
  ctx.persist();

  const runScratch = await Deno.makeTempDir({ prefix: "pagu-run-" });
  const runFile = `${runScratch}/${entry.id}.ts`;
  await Deno.writeTextFile(runFile, body);
  const result = await runScript({
    scriptPath: runFile,
    perms: [...skillPerms, ...ctx.denyFlags],
    cwd: ctx.repo ?? ctx.projectBase,
    sandbox: ctx.sandboxKind,
    scriptArgs: entry.args,
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
