// effects: invoke_skill execution — pipeline([resolveBody, ceilingGate, autoApprove, run])
import {
  autoApprove,
  cageWithinCeiling,
  type Exec,
  run,
  runHandlerStep,
} from "../capability/index.ts";
import { pipeline } from "../loop.ts";
import type { AgentContext, SkillInvocationEntry } from "../context.ts";

/** Return "stop" to exit runTask, "loop" to continue to the next turn. */
export async function executeSkillInvocation(
  entry: SkillInvocationEntry,
  ctx: AgentContext,
): Promise<"stop" | "loop"> {
  const exec: Exec = {
    ctx,
    id: entry.id,
    title: entry.script,
    body: "",
    perms: [],
    rationale: `auto-approved skill invocation: ${entry.script}`,
    scriptArgs: entry.args,
    cwd: ctx.repo ?? ctx.projectBase,
    outcome: "loop",
  };

  // resolveBody: re-read from disk (auto-approval is "what's currently on
  // disk," not a startup snapshot); reject if unknown or unreadable.
  const resolveBody = async (e: Exec) => {
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
      e.outcome = "loop";
      return "done" as const;
    }
    try {
      e.body = await Deno.readTextFile(ss.path);
    } catch (err) {
      ctx.ui.show(
        `✗ skill "${ss.name}": script not readable at ${ss.path}`,
      );
      ctx.log.push({
        kind: "decision",
        script: entry.id,
        verdict: "reject",
        rationale: `skill script unreadable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      ctx.persist();
      e.outcome = "stop";
      return "done" as const;
    }
    return "continue" as const;
  };

  // ceilingGate: cage the body, check discovered perms against the skill's
  // declared ceiling; reject (no fix loop) if exceeded or cage bug.
  const ceilingGate = async (e: Exec) => {
    const ss = ctx.activeSkillScripts.find((s) => s.name === entry.script)!;
    ctx.ui.status(`caging skill script: ${ss.name}…`);
    const perms = await cageWithinCeiling({
      body: e.body,
      id: entry.id,
      ctx,
      declared: ss.permissions,
      onExceed: (msg) => {
        ctx.ui.show(
          `✗ skill "${ss.name}" needs perms outside its declared ceiling — not run`,
        );
        ctx.log.push({
          kind: "decision",
          script: entry.id,
          verdict: "reject",
          rationale: msg,
        });
        ctx.persist();
        e.outcome = "stop";
      },
      onBug: (msg) => {
        ctx.ui.show(
          `✗ skill "${ss.name}" failed cage (pre-authored script — not sent back for fixing):\n${msg}`,
        );
        ctx.log.push({
          kind: "decision",
          script: entry.id,
          verdict: "reject",
          rationale: `cage bug: ${msg}`,
        });
        ctx.persist();
        e.outcome = "stop";
      },
    });
    if (perms === null) return "done" as const;
    e.perms = perms;
    return "continue" as const;
  };

  const handlers = ctx.activeHandlers.map((h) => runHandlerStep(h, ctx));
  await pipeline([resolveBody, ceilingGate, ...handlers, autoApprove, run])(
    exec,
  );
  return exec.outcome;
}
