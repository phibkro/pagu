// effects: shared execution substrate for all capability pipelines.
// The security-critical cage→autoApprove→run path is centralized here;
// per-capability gates stay in their own modules.
//
// Two audience layers (one concept: "a tool the agent can invoke"):
//   Public (consumers — registry, agent.ts, respond.ts):
//     Capability<Data>, AnyCapability
//   Author-facing (implementers — write/execute.ts, skills/execute.ts, etc.):
//     Exec, cageOnce, cageWithinCeiling, performRun, autoApprove, run
import {
  absolutizePerm,
  parsePermission,
  withinEnvelope,
} from "../permissions/index.ts";
import { classifyRun, type RunClass, runScript } from "../runner/index.ts";
import type { AgentContext } from "../context.ts";
import type { Entry } from "../log/index.ts";
import type { ToolDef } from "../providers/index.ts";
import type { Step } from "../loop.ts";

export type { RunClass };

// ── Capability<Data>: the public registry interface ──────────────────────────

/** One tool the agent can invoke — declared once, used by both processes.
 * Use `satisfies Capability<Data>` (not a type annotation) on declarations
 * so the literal entryKind type is preserved for registry derivation. */
export interface Capability<Data> {
  /** Log entry kind produced — the executor dispatch key. */
  entryKind: string;
  /** The model tool name this capability advertises. */
  toolName: string;
  /** Id prefix for log entries, e.g. "sk", "ci", "s". */
  idPrefix: string;
  /** Serializable data for the respond subprocess (the discover step).
   *  Called by the orchestrator each turn; result goes into phase input. */
  data(ctx: AgentContext): Data;
  /** Availability law: legal ∩ environment-present. */
  isAvailable(data: Data): boolean;
  /** Build the tool schema from this turn's data. Pure — respond subprocess only. */
  toolDef(data: Data): ToolDef;
  /** Parse a model tool-call into a typed log entry. Pure — respond subprocess only. */
  toEntry(args: Record<string, unknown>, id: string): Entry;
  /** Execute the log entry. Effectful — orchestrator only. Never called in the
   *  respond subprocess even though the module is imported there. */
  execute(entry: Entry, ctx: AgentContext): Promise<"stop" | "loop">;
}

/** Type-erased form for the registry (heterogeneous array of capabilities). */
export type AnyCapability = Capability<unknown>;

// ── Exec: the carrier threaded through a capability pipeline ─────────────────

/** Pure data; per-capability gates fill body and perms, the shared run
 * handler performs the execution. write uses its own Proposal carrier and
 * calls performRun directly. */
export interface Exec {
  ctx: AgentContext;
  id: string;
  title: string;
  body: string;
  perms: string[];
  rationale: string;
  scriptArgs?: string[];
  /** Explicit run cwd. When absent, performRun falls back to ctx.repo ?? scratch. */
  cwd?: string;
  outcome: "stop" | "loop";
}

/**
 * Read-only view of Exec for terminal handlers (autoApprove, run). The
 * gate-never-widen law: handlers may read body/perms but not replace them.
 * `Exec ⊆ ReadonlyExec` (mutable fields satisfy readonly), so
 * `Step<ReadonlyExec> ⊆ Step<Exec>` via contravariance — terminal handlers
 * declared as Step<ReadonlyExec> slot into Step<Exec> pipelines without casts.
 */
export type ReadonlyExec = Omit<Exec, "body" | "perms"> & {
  readonly body: string;
  readonly perms: readonly string[];
};

// ── Cage mechanics ───────────────────────────────────────────────────────────

/**
 * Run a script body in the cage (read-allowlist + scratch-write, no net) and
 * return the RunClass. Ceiling enforcement and fix loops are per-capability
 * concerns. cwd defaults to ctx.repo ?? the cage scratch dir.
 */
export async function cageOnce(params: {
  body: string;
  id: string;
  ctx: AgentContext;
  extraPerms?: string[];
  cwd?: string;
}): Promise<RunClass> {
  const { body, id, ctx, extraPerms = [], cwd: cwdParam } = params;
  const scratch = await Deno.makeTempDir({ prefix: "pagu-cage-" });
  const file = `${scratch}/${id}.ts`;
  await Deno.writeTextFile(file, body);
  const r = await runScript({
    scriptPath: file,
    perms: [
      ...ctx.readPaths.map((p) => `allow-read=${p}`),
      `allow-write=${scratch}`,
      ...extraPerms,
      ...ctx.denyFlags,
    ],
    cwd: cwdParam ?? ctx.repo ?? scratch,
    sandbox: ctx.sandboxKind,
  });
  await Deno.remove(scratch, { recursive: true });
  return classifyRun(r.exit, r.stderr);
}

/**
 * Cage a body against a declared ceiling. Returns absolutized discovered
 * perms (including readPaths) on success, null if the ceiling is exceeded
 * or the cage hit a bug. Shared by the skill gate and task-with-ceiling gate.
 */
export async function cageWithinCeiling(params: {
  body: string;
  id: string;
  ctx: AgentContext;
  declared: string[];
  cwd?: string;
  onExceed?: (msg: string) => void;
  onBug?: (msg: string) => void;
}): Promise<string[] | null> {
  const { body, id, ctx, declared, cwd, onExceed, onBug } = params;
  const base = ctx.repo ?? Deno.cwd();
  const cls = await cageOnce({ body, id, ctx, extraPerms: declared, cwd });

  if (cls.kind === "ok") {
    return ctx.readPaths.map((p) => `allow-read=${p}`);
  }
  if (cls.kind === "needs-perms") {
    const discovered = cls.perms.map((s) =>
      parsePermission(absolutizePerm(s, base))
    );
    const ceiling = declared.flatMap((p) => {
      try {
        return [parsePermission(p)];
      } catch {
        return [];
      }
    });
    if (!withinEnvelope(discovered, { allow: ceiling })) {
      onExceed?.("discovered perms exceed declared ceiling");
      return null;
    }
    return [
      ...ctx.readPaths.map((p) => `allow-read=${p}`),
      ...cls.perms.map((s) => absolutizePerm(s, base)),
    ];
  }
  // bug
  onBug?.(cls.error);
  return null;
}

// ── Shared run logic ─────────────────────────────────────────────────────────

/**
 * Execute an approved script: write body to scratch, run with granted perms,
 * log the result entry, apply the net-output gate, return "stop" or "loop".
 * cwd defaults to ctx.repo ?? the run scratch dir (behavior-identical with
 * write's original run handler, which also used its scratch as the fallback).
 */
export async function performRun(params: {
  ctx: AgentContext;
  id: string;
  body: string;
  perms: readonly string[];
  scriptArgs?: string[];
  cwd?: string;
}): Promise<"stop" | "loop"> {
  const { ctx, id, body, perms, scriptArgs, cwd: cwdParam } = params;
  const scratch = await Deno.makeTempDir({ prefix: "pagu-run-" });
  const file = `${scratch}/${id}.ts`;
  await Deno.writeTextFile(file, body);

  // Stream stdout live when the frontend supports it (TUI/ACP). The batch
  // result still goes to the log regardless; only the display changes.
  const streaming = !!ctx.ui.stream;
  const result = await runScript({
    scriptPath: file,
    perms: [...perms, ...ctx.denyFlags],
    cwd: cwdParam ?? ctx.repo ?? scratch,
    sandbox: ctx.sandboxKind,
    scriptArgs,
    onStdout: streaming ? (chunk) => ctx.ui.stream!(chunk) : undefined,
  });
  await Deno.remove(scratch, { recursive: true });

  const output = result.stdout || result.stderr;
  const resultEntry = {
    kind: "result" as const,
    script: id,
    exit: result.exit,
    ranWith: result.ranWith,
    output,
    sandbox: result.sandbox,
  };
  ctx.log.push(resultEntry);
  ctx.persist();
  ctx.ui.entries?.([resultEntry]);

  // When streaming, stdout was shown live — show only the exit-status header
  // to avoid reprinting it. Non-streaming (CLI) shows header + full output.
  if (streaming && result.stdout) {
    ctx.ui.show(`\n--- result (exit ${result.exit}) ---`);
  } else {
    ctx.ui.show(`\n--- result (exit ${result.exit}) ---\n${output}`);
  }

  if (result.ranWith.some((f) => /--allow-(net|all)\b/.test(f))) {
    ctx.ui.show(
      "\n[net was granted — output would NOT auto-return to the agent]",
    );
    return "stop";
  }
  return "loop";
}

// ── Shared Step<ReadonlyExec> terminal handlers ──────────────────────────────
// Typed as Step<ReadonlyExec> so the compiler enforces gate-never-widen:
// handlers can read body/perms but cannot replace them. Step<ReadonlyExec>
// satisfies Step<Exec> via contravariance (Exec ⊆ ReadonlyExec) so these slot
// into Step<Exec> pipelines without casts.

/** Log the approve decision + set running status; always continues. Shared
 * by skill/task/command (write keeps its own approve with the human gate). */
export const autoApprove: Step<ReadonlyExec> = (exec) => {
  exec.ctx.ui.status(`running: ${exec.title}…`);
  exec.ctx.log.push({
    kind: "decision",
    script: exec.id,
    verdict: "approve",
    rationale: exec.rationale,
  });
  exec.ctx.persist();
  return Promise.resolve("continue");
};

/** Terminal run handler: call performRun, set outcome, always halt. */
export const run: Step<ReadonlyExec> = async (exec) => {
  exec.outcome = await performRun({
    ctx: exec.ctx,
    id: exec.id,
    body: exec.body,
    perms: exec.perms,
    scriptArgs: exec.scriptArgs,
    cwd: exec.cwd,
  });
  return "done";
};
