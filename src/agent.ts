// imperative shell: orchestrates effects; the decisions it calls are pure
import { join } from "@std/path";
import { spawnPhase } from "./phases/spawn.ts";
import {
  AgentContext,
  Approver,
  isCommandInvoke,
  isScript,
  isSkillInvoke,
  Responder,
  UI,
} from "./context.ts";
import { executeSkillInvocation } from "./skills/index.ts";
import { executeCommandInvocation } from "./tasks/index.ts";
import { executeScriptProposal } from "./write/index.ts";
import type { Entry } from "./log/index.ts";

// Re-export the port interfaces — frontends import from here.
export type { AgentContext, Approver, UI };

const MAX_TURNS = 6;

/**
 * The respond phase's permissions — **invariant #1 in code**. The only process
 * the model drives may read the allowlist and reach the model, nothing else:
 * never write, run, env, or blanket allow. `agent.test.ts` asserts this so a
 * future edit can't silently widen it.
 */
export function respondFlags(
  providerHost: string,
  readPaths: string[],
): string[] {
  return [
    `--allow-net=${providerHost}`,
    ...readPaths.map((p) => `--allow-read=${p}`),
  ];
}

/** Strip spawnPhase's `phase <entry> exited <n>: ` wrapper. */
function cleanPhaseError(msg: string): string {
  const inner = msg.replace(/^phase\s+\S+\s+exited\s+\d+:\s*/, "");
  return inner.split("\n")[0].trim() || msg;
}

/**
 * Run one task as a conversation. Each turn spawns the respond phase, which
 * either replies in chat (done) or emits an action entry (skill-invoke,
 * command-invoke, or script). The orchestrator dispatches to the appropriate
 * capability module, which owns the full cage → approval → run pipeline.
 */
export async function runTask(ctx: AgentContext, task: string): Promise<void> {
  const input = () => ({
    log: ctx.log,
    provider: ctx.provider,
    agents: ctx.agents,
    capabilities: ctx.capabilities,
    skillScripts: ctx.activeSkillScripts.map((ss) => ({
      name: ss.name,
      description: ss.description,
    })),
    gitignored: ctx.gitignored,
    allowedTasks: buildAllowedTasks(ctx),
  });

  const respond: Responder = () =>
    spawnPhase({
      entry: join(ctx.phaseDir, "respond.ts"),
      flags: respondFlags(ctx.providerHost, ctx.readPaths),
      input: input(),
      onStderr: ctx.ui.stream ? (c) => ctx.ui.stream!(c) : undefined,
    });

  const showReply = (entries: Entry[]) => {
    const msgs = entries.filter(
      (e): e is Extract<Entry, { kind: "message" }> =>
        e.kind === "message" && e.role === "assistant",
    );
    if (msgs.length === 0) return;
    if (ctx.ui.stream) ctx.ui.stream("\n");
    else for (const m of msgs) ctx.ui.show(m.text);
  };

  ctx.log.push({ kind: "message", role: "user", text: task });
  ctx.persist();

  try {
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      ctx.ui.status(turn === 1 ? "thinking…" : "continuing…");
      const produced = await respond();
      ctx.log.push(...produced);
      ctx.persist();
      showReply(produced);

      const skillInvoke = produced.findLast(isSkillInvoke);
      if (skillInvoke) {
        const action = await executeSkillInvocation(skillInvoke, ctx);
        if (action === "stop") return;
        continue;
      }

      const cmdInvoke = produced.findLast(isCommandInvoke);
      if (cmdInvoke) {
        const action = await executeCommandInvocation(cmdInvoke, ctx);
        if (action === "stop") return;
        continue;
      }

      const script = produced.findLast(isScript);
      if (!script) return; // pure chat turn — no action needed
      const action = await executeScriptProposal(
        script,
        task,
        ctx,
        respond,
        showReply,
      );
      if (action === "stop") return;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.ui.show("✗ " + cleanPhaseError(msg));
  }
}

/** Build the allowed-tasks list for the phase input. */
function buildAllowedTasks(ctx: AgentContext) {
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
