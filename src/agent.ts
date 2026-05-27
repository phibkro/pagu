// imperative shell: orchestrates effects; the decisions it calls are pure
import { join, resolve } from "@std/path";
import { spawnPhase } from "./phases/spawn.ts";
import { runScript } from "./runner/run.ts";
import { classifyRun } from "./runner/classify.ts";
import {
  type Envelope,
  formatFlag,
  parsePermission,
} from "./permissions/envelope.ts";
import { shouldAutoApprove } from "./permissions/policy.ts";
import { formatAdvisory, runAdvisor } from "./advisor.ts";
import { buildReview, formatReview } from "./review.ts";
import type { SandboxKind } from "./runner/sandbox.ts";
import type { Entry } from "./log/schema.ts";
import type { ProviderConfig } from "./provider/chat.ts";
import type { SessionMeta } from "./sessions.ts";

/**
 * The I/O-agnostic core loop. Flags, config, and a TUI are all just
 * interfaces that build an AgentContext and supply a `ui` + `approve`;
 * `runTask` doesn't know or care which frontend it's driven by.
 */

type ScriptEntry = Extract<Entry, { kind: "script" }>;
const isScript = (e: Entry): e is ScriptEntry => e.kind === "script";

/** The one I/O seam for the human review gate (stdin / TUI prompt). Only
 * called when a proposal is NOT auto-approvable. The perms it would run
 * with are already shown by the core; the approver answers yes/no. */
export type Approver = (
  script: ScriptEntry,
  perms: string[],
) => Promise<boolean>;

/** Output sink: `status` for transient progress, `show` for results. An
 * optional `stream` consumes model tokens live; if present, the core lets
 * the stream render the assistant's text instead of re-printing it. */
export interface UI {
  status(msg: string): void;
  show(msg: string): void;
  stream?(chunk: string): void;
}

export interface AgentContext {
  provider: ProviderConfig;
  providerHost: string;
  /** Switch provider/model at runtime; returns a status line to display. */
  setProvider: (
    change: { provider?: string; model?: string; baseURL?: string },
  ) => { ok: boolean; message: string };
  /** The active provider preset name (reflects roles/flags + /provider). */
  providerName: () => string;
  /** Project dir (git root, else cwd) where roles are discovered. */
  projectBase: string;
  /** Names of the currently applied roles, in compose order. */
  roleNames: () => string[];
  /** Set the active role group at runtime: re-folds config and re-derives
   * permissions/prose. Fails loud (state unchanged) on an unknown name. */
  setRoles: (names: string[]) => Promise<{ ok: boolean; message: string }>;
  phaseDir: string;
  agents: string;
  readPaths: string[];
  repo?: string;
  envelope: Envelope;
  denyFlags: string[];
  /** Advisory reviewer config — present = enabled, absent = disabled.
   * Falls back to no advisor when undefined; use a copy of ctx.provider to
   * enable with the default provider. */
  advisorConfig?: ProviderConfig;
  /** Toggle advisor on/off and optionally reconfigure its provider/model. */
  setAdvisor: (
    change: { enabled?: boolean; provider?: string; model?: string },
  ) => { ok: boolean; message: string };
  /** A description of what authored scripts can actually do (read/write
   * scope), injected into the agent's prompt so it knows its real reach. */
  capabilities: string;
  /** OS sandbox tier wrapping every run (bubblewrap / sandbox-exec / none). */
  sandboxKind: SandboxKind;
  /** The active conversation, mutated in place (so a session switch keeps
   * this reference valid). Append events here; call persist to save. */
  log: Entry[];
  persist: () => void;
  /** Directory sessions live under (git repo root, else cwd). */
  sessionBase: string;
  /** Path of the active session's log file (changes on switchSession). */
  currentLogPath: () => string;
  /** Switch the active session: repoint persist, swap metadata, and reload
   * the log in place. Does not persist; the caller decides when to save. */
  switchSession: (path: string, entries: Entry[], meta: SessionMeta) => void;
  /** Set the active session's display name and persist it (frontmatter). */
  rename: (name: string) => void;
  ui: UI;
  approve: Approver;
}

/** Resolve a discovered perm's path scope to absolute against `base`. */
function absolutizePerm(flagStr: string, base: string): string {
  const p = parsePermission(flagStr);
  if ((p.flag === "read" || p.flag === "write") && p.scope) {
    return formatFlag({ flag: p.flag, scope: resolve(base, p.scope) });
  }
  return flagStr;
}

const MAX_FIX = 3;
const MAX_TURNS = 6;

/**
 * The respond phase's permissions — **invariant #1 in code**. The only process
 * the model drives may read the allowlist and reach the model, nothing else:
 * never write, run, env, or blanket allow. `agent.test.ts` asserts this so a
 * future edit can't silently widen it. (The runner, not this phase, holds the
 * real-effect perms — and only after approval.)
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

/** Strip spawnPhase's `phase <entry> exited <n>: ` wrapper to surface the
 * phase's own message (e.g. a one-line provider error) on a single line. */
function cleanPhaseError(msg: string): string {
  const inner = msg.replace(/^phase\s+\S+\s+exited\s+\d+:\s*/, "");
  return inner.split("\n")[0].trim() || msg;
}

/**
 * Run one task as a conversation. Each turn spawns the `respond` phase,
 * which either replies in text (a chat turn — we show it and stop) or
 * proposes a script (we cage-test → review → run, then loop so the model
 * sees the result and can continue or wrap up). Appends events to ctx.log
 * (persisted as it goes).
 */
export async function runTask(ctx: AgentContext, task: string): Promise<void> {
  const input = () => ({
    log: ctx.log,
    provider: ctx.provider,
    agents: ctx.agents,
    capabilities: ctx.capabilities,
  });
  const stream = ctx.ui.stream;
  const respond = () =>
    spawnPhase({
      entry: join(ctx.phaseDir, "respond.ts"),
      flags: respondFlags(ctx.providerHost, ctx.readPaths),
      input: input(),
      onStderr: stream ? (c) => stream(c) : undefined,
    });
  // If the assistant's text streamed live, terminate the line instead of
  // re-printing the message entry; otherwise show it as a block.
  const showReply = (entries: Entry[]) => {
    const msgs = entries.filter(
      (e): e is Extract<Entry, { kind: "message" }> =>
        e.kind === "message" && e.role === "assistant",
    );
    if (msgs.length === 0) return;
    if (stream) stream("\n");
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

      // Show any chat text the model emitted this turn (it may precede a
      // proposed script as an explanation, or stand alone as the reply).
      showReply(produced);

      let script = produced.findLast(isScript);
      if (!script) return; // pure chat turn — no action needed, done.

      const initialBody = script.body; // captured for diff if cage revises it

      // Cage self-test: no net, real reads in scope, writes only to scratch.
      let discovered: string[] = [];
      for (let attempt = 1; attempt <= MAX_FIX; attempt++) {
        const scratch = await Deno.makeTempDir({ prefix: "pagu-cage-" });
        const file = `${scratch}/${script.id}.ts`;
        await Deno.writeTextFile(file, script.body);
        ctx.ui.status(`self-testing in cage (attempt ${attempt})…`);
        const r = await runScript({
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

        const cls = classifyRun(r.exit, r.stderr);
        if (cls.kind === "ok") break;
        if (cls.kind === "needs-perms") {
          discovered = cls.perms;
          break;
        }
        if (attempt === MAX_FIX) {
          ctx.ui.status("self-test still failing; presenting last attempt.");
          break;
        }
        ctx.log.push({
          kind: "message",
          role: "user",
          text: `Sandbox self-test of ${script.id} failed:\n${
            cls.error || "(no output; possibly timed out)"
          }\nFix the script and propose it again with the write tool.`,
        });
        ctx.persist();
        ctx.ui.status("fixing…");
        const fixed = await respond();
        ctx.log.push(...fixed);
        ctx.persist();
        showReply(fixed);
        const next = fixed.findLast(isScript);
        if (!next) break;
        script = next;
      }

      // Deno reports denied paths as the script referenced them (often
      // relative); resolve to absolute to match the absolute envelope.
      discovered = discovered.map((s) =>
        absolutizePerm(s, ctx.repo ?? Deno.cwd())
      );
      const perms = [
        ...ctx.readPaths.map((p) => `allow-read=${p}`),
        ...discovered,
      ];

      // Review: auto within envelope, else hand to the frontend's approver
      // (a simple yes/no; the perms it would run with are always shown).
      let approved: boolean;
      if (
        shouldAutoApprove(
          discovered.map(parsePermission),
          ctx.envelope,
          !!ctx.repo,
        )
      ) {
        ctx.ui.status("auto-approved (within session envelope)");
        approved = true;
      } else {
        const review = buildReview({
          perms,
          envelope: ctx.envelope,
          body: script.body,
          prevBody: script.body !== initialBody ? initialBody : undefined,
        });
        ctx.ui.show(formatReview(review, script.id, script.lang, script.body));
        if (ctx.advisorConfig) {
          const advisory = formatAdvisory(
            await runAdvisor({
              task,
              script: script.body,
              perms,
              provider: ctx.advisorConfig,
            }),
          );
          if (advisory) ctx.ui.show(advisory);
        }
        approved = await ctx.approve(script, perms);
      }

      if (!approved) {
        ctx.log.push({
          kind: "decision",
          script: script.id,
          verdict: "reject",
          rationale: "rejected at review",
        });
        ctx.persist();
        ctx.ui.show("rejected.");
        return;
      }
      ctx.log.push({
        kind: "decision",
        script: script.id,
        verdict: "approve",
        rationale: `approved with: ${perms.join(" ") || "(no perms)"}`,
      });
      ctx.persist();

      // Run: real effects, scoped to granted perms + session denies.
      ctx.ui.status("running…");
      const scratch = await Deno.makeTempDir({ prefix: "pagu-run-" });
      const file = `${scratch}/${script.id}.ts`;
      await Deno.writeTextFile(file, script.body);
      const result = await runScript({
        scriptPath: file,
        perms: [...perms, ...ctx.denyFlags],
        cwd: ctx.repo ?? scratch,
        sandbox: ctx.sandboxKind,
      });
      await Deno.remove(scratch, { recursive: true });

      const output = result.stdout || result.stderr;
      ctx.log.push({
        kind: "result",
        script: script.id,
        exit: result.exit,
        ranWith: result.ranWith,
        output,
      });
      ctx.persist();
      ctx.ui.show(`\n--- result (exit ${result.exit}) ---\n${output}`);
      if (result.ranWith.some((f) => /--allow-(net|all)\b/.test(f))) {
        ctx.ui.show(
          "\n[net was granted — output would NOT auto-return to the agent]",
        );
        return; // can't safely feed exfil-capable output back to the model.
      }
      // Loop: re-invoke respond so the model sees the result and either
      // wraps up (chat reply) or proposes a follow-up script.
    }
  } catch (e) {
    // A phase that failed on a provider HTTP error (auth/model/billing)
    // surfaces as one clean line, not a stack — see cleanPhaseError.
    const msg = e instanceof Error ? e.message : String(e);
    ctx.ui.show("✗ " + cleanPhaseError(msg));
  }
}
