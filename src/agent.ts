// imperative shell: orchestrates effects; the decisions it calls are pure
import { resolve } from "jsr:@std/path@^1";
import { spawnPhase } from "./phases/spawn.ts";
import { runScript } from "./runner/run.ts";
import { classifyRun } from "./runner/classify.ts";
import {
  type Envelope,
  formatFlag,
  parsePermission,
} from "./perms/envelope.ts";
import { shouldAutoApprove } from "./session.ts";
import type { Entry } from "./log/schema.ts";
import type { ProviderConfig } from "./provider/chat.ts";

/**
 * The I/O-agnostic core loop. Flags, config, and a TUI are all just
 * interfaces that build an AgentContext and supply a `ui` + `approve`;
 * `runTask` doesn't know or care which frontend it's driven by.
 */

type ScriptEntry = Extract<Entry, { kind: "script" }>;
const isScript = (e: Entry): e is ScriptEntry => e.kind === "script";

export interface Decision {
  verdict: "approve" | "reject";
  perms: string[];
}

/** The one I/O seam for the human review gate (stdin / TUI prompt). Only
 * called when a proposal is NOT auto-approvable. */
export type Approver = (
  script: ScriptEntry,
  suggested: string[],
) => Promise<Decision>;

/** Output sink: `status` for transient progress, `show` for results. */
export interface UI {
  status(msg: string): void;
  show(msg: string): void;
}

export interface AgentContext {
  provider: ProviderConfig;
  providerHost: string;
  phaseDir: string;
  agents: string;
  readPaths: string[];
  repo?: string;
  envelope: Envelope;
  denyFlags: string[];
  autoEnabled: boolean;
  log: Entry[];
  persist: () => void;
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

/** Run one task end-to-end: observe → author → cage self-test → review →
 * run. Appends events to ctx.log (persisted as it goes). */
export async function runTask(ctx: AgentContext, task: string): Promise<void> {
  const input = () => ({
    log: ctx.log,
    provider: ctx.provider,
    agents: ctx.agents,
  });
  const author = () =>
    spawnPhase({
      entry: `${ctx.phaseDir}author.ts`,
      flags: [`--allow-net=${ctx.providerHost}`],
      input: input(),
    });

  ctx.log.push({ kind: "message", role: "user", text: task });
  ctx.persist();

  // Observe
  ctx.ui.status("observing…");
  ctx.log.push(
    ...await spawnPhase({
      entry: `${ctx.phaseDir}observe.ts`,
      flags: [
        `--allow-net=${ctx.providerHost}`,
        ...ctx.readPaths.map((p) => `--allow-read=${p}`),
      ],
      input: input(),
    }),
  );
  ctx.persist();

  // Author
  ctx.ui.status("authoring…");
  let authored = await author();
  ctx.log.push(...authored);
  ctx.persist();
  let script = authored.findLast(isScript);
  if (!script) {
    const msg = authored.find((e) => e.kind === "message");
    ctx.ui.show(
      msg && msg.kind === "message" ? msg.text : "(no script proposed)",
    );
    return;
  }

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
    authored = await author();
    ctx.log.push(...authored);
    ctx.persist();
    const next = authored.findLast(isScript);
    if (!next) break;
    script = next;
  }

  // Deno reports denied paths as the script referenced them (often
  // relative); resolve to absolute to match the absolute envelope.
  discovered = discovered.map((s) => absolutizePerm(s, ctx.repo ?? Deno.cwd()));
  const suggested = [
    ...ctx.readPaths.map((p) => `allow-read=${p}`),
    ...discovered,
  ];

  // Review: auto within envelope, else hand to the frontend's approver.
  let decision: Decision;
  if (
    shouldAutoApprove(
      discovered.map(parsePermission),
      ctx.envelope,
      ctx.autoEnabled,
    )
  ) {
    ctx.ui.status("auto-approved (within session envelope)");
    decision = { verdict: "approve", perms: suggested };
  } else {
    ctx.ui.show(
      `\n--- proposed ${script.id} (${script.lang}) ---\n${script.body}\n`,
    );
    if (suggested.length > 0) {
      ctx.ui.show(`suggested perms (from sandbox): ${suggested.join(" ")}`);
    }
    decision = await ctx.approve(script, suggested);
  }

  if (decision.verdict === "reject") {
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
    rationale: `approved with: ${decision.perms.join(" ") || "(no perms)"}`,
  });
  ctx.persist();

  // Run: real effects, scoped to granted perms + session denies.
  ctx.ui.status("running…");
  const scratch = await Deno.makeTempDir({ prefix: "pagu-run-" });
  const file = `${scratch}/${script.id}.ts`;
  await Deno.writeTextFile(file, script.body);
  const result = await runScript({
    scriptPath: file,
    perms: [...decision.perms, ...ctx.denyFlags],
    cwd: ctx.repo ?? scratch,
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
  if (!result.autoReturn) {
    ctx.ui.show(
      "\n[net was granted — output would NOT auto-return to the agent]",
    );
  }
}
