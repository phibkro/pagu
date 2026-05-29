// imperative shell: orchestrates effects; the decisions it calls are pure
import { join } from "@std/path";
import { spawnPhase } from "./phases/spawn.ts";
import { AgentContext, ApprovalOutcome, Approver, UI } from "./context.ts";
import { actionCapabilities, isActionEntry } from "./capability/registry.ts";
import { performRun } from "./capability/index.ts";
import { pendingProposal } from "./approval.ts";
import type { Entry } from "./log/index.ts";
import { type Flow, loop, type Step } from "./loop.ts";
import { buildAllowedTasks } from "./tasks/capability.ts";

// Re-export the port interfaces — frontends import from here.
export type { AgentContext, ApprovalOutcome, Approver, UI };

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

/** The serializable slice of context the respond subprocess reads each turn. */
function phaseInput(ctx: AgentContext) {
  return {
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
  };
}

/**
 * Inject `ctx.respond` (the cage fix-loop in write/pipeline.ts uses it; the
 * Application layer can't import spawnPhase directly). The signal threads
 * through so Ctrl-C / session/cancel kills the subprocess.
 */
function injectRespond(ctx: AgentContext, signal?: AbortSignal): void {
  ctx.respond = () =>
    spawnPhase({
      entry: join(ctx.phaseDir, "respond.ts"),
      flags: respondFlags(ctx.providerHost, ctx.readPaths),
      input: phaseInput(ctx),
      onStream: ctx.ui.stream
        ? (c) => ctx.ui.stream!(c.text, c.channel)
        : undefined,
      signal,
    });
}

function showReply(ctx: AgentContext, entries: Entry[]): void {
  const msgs = entries.filter(
    (e): e is Extract<Entry, { kind: "message" }> =>
      e.kind === "message" && e.role === "assistant",
  );
  if (msgs.length === 0) return;
  if (ctx.ui.stream) ctx.ui.stream("\n");
  else for (const m of msgs) ctx.ui.show(m.text);
}

/** One conversational turn: spawn respond, append what it produced, dispatch
 * any action entry via the capability registry. */
function makeTurn(ctx: AgentContext, signal?: AbortSignal): Step<AgentContext> {
  let turnIndex = 0;
  return async (): Promise<Flow> => {
    if (signal?.aborted) return "done"; // inter-turn cancellation check
    ctx.ui.status(turnIndex++ === 0 ? "thinking…" : "continuing…");
    const produced = await ctx.respond();
    ctx.log.push(...produced);
    ctx.persist();
    showReply(ctx, produced);
    ctx.ui.entries?.(produced);

    const action = produced.findLast(isActionEntry);
    if (!action) return "done"; // pure chat turn

    const cap = actionCapabilities.find((c) => c.entryKind === action.kind)!;
    return (await cap.execute(action, ctx)) === "stop" ? "done" : "continue";
  };
}

/** Run `body`, turning a cancellation into a clean message and any other error
 * into one diagnostic line (shared by runTask + resumeTask). */
async function guarded(
  ctx: AgentContext,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      ctx.ui.show("· cancelled");
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    ctx.ui.show("✗ " + cleanPhaseError(msg));
  }
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
  injectRespond(ctx, signal);
  ctx.log.push({ kind: "message", role: "user", text: task });
  ctx.persist();
  await guarded(ctx, async () => {
    await loop(makeTurn(ctx, signal), MAX_TURNS)(ctx);
  });
}

/**
 * Resolve the session's one pending proposal — the durable gate. `approve`
 * records the decision, runs the proposal **reconstructed from its logged
 * `script`+`perms`** (no re-cage), then continues the loop; `reject`/`expired`
 * record a terminal decision and stop. A no-op if nothing is pending. The
 * counterpart to `runTask`: both are folds of the single-writer log, so a fresh
 * process resumes a deferred proposal identically to the live one.
 */
export async function resumeTask(
  ctx: AgentContext,
  verdict: "approve" | "reject" | "expired",
  signal?: AbortSignal,
): Promise<void> {
  const pending = pendingProposal(ctx.log);
  if (!pending) return;
  injectRespond(ctx, signal);

  if (verdict !== "approve") {
    ctx.log.push({
      kind: "decision",
      script: pending.script.id,
      verdict,
      rationale: verdict === "expired"
        ? "expired before a decision"
        : "rejected",
    });
    ctx.persist();
    ctx.ui.show(verdict === "expired" ? "· proposal expired" : "rejected.");
    return;
  }

  ctx.log.push({
    kind: "decision",
    script: pending.script.id,
    verdict: "approve",
    rationale: `approved with: ${pending.perms.join(" ") || "(no perms)"}`,
  });
  ctx.persist();
  await guarded(ctx, async () => {
    const outcome = await performRun({
      ctx,
      id: pending.script.id,
      body: pending.script.body,
      perms: pending.perms,
    });
    if (outcome === "loop") await loop(makeTurn(ctx, signal), MAX_TURNS)(ctx);
  });
}
