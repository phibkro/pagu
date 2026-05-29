// imperative shell: orchestrates effects; the decisions it calls are pure
import { join } from "@std/path";
import { spawnPhase } from "./phases/spawn.ts";
import { AgentContext, Approver, UI } from "./context.ts";
import { actionCapabilities, isActionEntry } from "./capability/registry.ts";
import type { Entry } from "./log/index.ts";
import { type Flow, loop, type Step } from "./loop.ts";
import { buildAllowedTasks } from "./tasks/capability.ts";

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
 * either replies in chat (done) or emits an action entry dispatched via the
 * capability registry.
 */
export async function runTask(
  ctx: AgentContext,
  task: string,
  signal?: AbortSignal,
): Promise<void> {
  const input = () => ({
    log: ctx.log,
    provider: ctx.provider,
    agents: ctx.agents,
    capabilities: ctx.capabilities,
    skillScripts: ctx.activeSkillScripts.map((ss) => ({
      name: ss.name,
      description: ss.description,
    })),
    conceal: ctx.conceal,
    allowedTasks: buildAllowedTasks(ctx),
    commandRules: ctx.availableCommandRules,
  });

  // Inject respond onto ctx — the cage fix-loop in write/pipeline.ts uses
  // ctx.respond (Application layer can't import spawnPhase directly).
  // The signal threads through so Ctrl-C / session/cancel kills the subprocess.
  ctx.respond = () =>
    spawnPhase({
      entry: join(ctx.phaseDir, "respond.ts"),
      flags: respondFlags(ctx.providerHost, ctx.readPaths),
      input: input(),
      onStderr: ctx.ui.stream ? (c) => ctx.ui.stream!(c) : undefined,
      signal,
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

  let turnIndex = 0;
  const turn: Step<AgentContext> = async (): Promise<Flow> => {
    if (signal?.aborted) return "done"; // inter-turn cancellation check
    ctx.ui.status(turnIndex++ === 0 ? "thinking…" : "continuing…");
    const produced = await ctx.respond();
    ctx.log.push(...produced);
    ctx.persist();
    showReply(produced);
    ctx.ui.entries?.(produced);

    const action = produced.findLast(isActionEntry);
    if (!action) return "done"; // pure chat turn

    const cap = actionCapabilities.find((c) => c.entryKind === action.kind)!;
    return (await cap.execute(action, ctx)) === "stop" ? "done" : "continue";
  };

  ctx.log.push({ kind: "message", role: "user", text: task });
  ctx.persist();

  try {
    await loop(turn, MAX_TURNS)(ctx);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      ctx.ui.show("· cancelled");
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    ctx.ui.show("✗ " + cleanPhaseError(msg));
  }
}
