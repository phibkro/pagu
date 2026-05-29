// effects: the write-capability pipeline as composable handlers.
// A handler is a Step<Proposal> (the loop substrate's generic Step at C=Proposal);
// the pipeline is their andThen-composition. A gate is a handler that can halt
// (return "done"). Handlers may tighten (refuse/narrow) but never widen beyond the
// envelope — the gate-never-widen law (see docs/CONCEPTS.md, the proposal–handler
// model). cage → approve → run reproduces the former executeScriptProposal exactly.
import { absolutizePerm, parsePermission } from "../permissions/index.ts";
import { shouldAutoApprove } from "../permissions/index.ts";
import { cageOnce, performRun } from "../capability/index.ts";
import { matchesSkillScript } from "../skills/index.ts";
import { activeGrants, makeGrant } from "../approval.ts";
import { buildReview, formatReview } from "./review.ts";
import { formatAdvisory, runAdvisor } from "./advisor.ts";
import type { AgentContext, ApprovalOutcome, ScriptEntry } from "../context.ts";
import { isScript } from "../context.ts";
import type { Entry } from "../log/index.ts";
import type { Step } from "../loop.ts";

const MAX_FIX = 3;

/** The carrier threaded through the handler pipeline for one proposal. Mutable:
 * handlers read and mutate it (same style as the turn over ctx.log). `discovered`
 * + `initialBody` are the canonical state; `perms`/`discoveredPerms` derive.
 * task/respond/showReply are accessed via ctx (respond is DI'd by agent.ts). */
export interface Proposal {
  ctx: AgentContext;
  script: ScriptEntry; // mutated by the cage fix loop
  initialBody: string; // pre-cage body, for the review iteration diff
  discovered: string[]; // cage's absolutized perm output; [] until cage runs
  approved?: boolean;
  outcome: "stop" | "loop"; // the return to the turn loop; default "loop"
}

export type Handler = Step<Proposal>;

/** The full permission list as the runner/review see it: readPaths + discovered. */
const fullPerms = (p: Proposal): string[] => [
  ...p.ctx.readPaths.map((path) => `allow-read=${path}`),
  ...p.discovered,
];

/** Cage self-test (with the inner fix loop) + permission discovery. Mutates
 * `script` (a fix round may replace it) and sets `discovered`. Always continues —
 * even a still-failing self-test presents to approval. */
export const cage: Handler = async (p) => {
  const base = p.ctx.repo ?? Deno.cwd();
  let current = p.script;
  let discovered: string[] = [];

  for (let attempt = 1; attempt <= MAX_FIX; attempt++) {
    p.ctx.ui.status(`self-testing in cage (attempt ${attempt})…`);
    const cls = await cageOnce({
      body: current.body,
      id: current.id,
      ctx: p.ctx,
    });

    if (cls.kind === "ok") break;
    if (cls.kind === "needs-perms") {
      discovered = cls.perms;
      break;
    }
    if (attempt === MAX_FIX) {
      p.ctx.ui.status("self-test still failing; presenting last attempt.");
      break;
    }
    p.ctx.log.push({
      kind: "message",
      role: "user",
      text: `Sandbox self-test of ${current.id} failed:\n${
        cls.error || "(no output; possibly timed out)"
      }\nFix the script and propose it again with the write tool.`,
    });
    p.ctx.persist();
    p.ctx.ui.status("fixing…");
    const fixed = await p.ctx.respond();
    p.ctx.log.push(...fixed);
    p.ctx.persist();
    // showReply: surface assistant messages from the fix round
    const fixMsgs = fixed.filter(
      (e): e is Extract<Entry, { kind: "message" }> =>
        e.kind === "message" && e.role === "assistant",
    );
    if (fixMsgs.length > 0) {
      if (p.ctx.ui.stream) p.ctx.ui.stream("\n");
      else for (const m of fixMsgs) p.ctx.ui.show(m.text);
    }
    const next = fixed.findLast(isScript);
    if (!next) break;
    current = next;
  }

  p.script = current;
  p.discovered = discovered.map((s) => absolutizePerm(s, base));
  return "continue";
};

/** The approval gate: auto-approve (within envelope) | skill-match | human review
 * (+ advisory). Halts (done) on reject, setting outcome="stop"; continues on
 * approve. Derives perms/discoveredPerms from `discovered`. */
export const approve: Handler = async (p) => {
  const perms = fullPerms(p);
  const discoveredPerms = p.discovered.map(parsePermission);
  // Persist the gated permission set (the `perms` entry) before deciding, so a
  // deferred proposal is a self-contained pending state in the log — script +
  // perms, no decision — that a fresh process or remote client can resume.
  p.ctx.log.push({ kind: "perms", script: p.script.id, perms });
  p.ctx.persist();
  const matchedSkill = matchesSkillScript(
    p.script.body,
    discoveredPerms,
    p.ctx.activeSkillScripts,
  );

  let outcome: ApprovalOutcome;
  if (
    shouldAutoApprove(
      discoveredPerms,
      p.ctx.envelope,
      !!p.ctx.repo,
      activeGrants(p.ctx.log, Date.now()),
    )
  ) {
    p.ctx.ui.status("auto-approved (envelope or standing grant)");
    outcome = "approve";
  } else if (matchedSkill) {
    p.ctx.ui.status(`auto-approved (skill script: ${matchedSkill.name})`);
    outcome = "approve";
  } else {
    const review = buildReview({
      perms,
      envelope: p.ctx.envelope,
      body: p.script.body,
      prevBody: p.script.body !== p.initialBody ? p.initialBody : undefined,
    });
    p.ctx.ui.show(
      formatReview(review, p.script.id, p.script.lang, p.script.body),
    );
    if (p.ctx.advisorConfig) {
      const task = p.ctx.log.findLast(
        (e): e is Extract<Entry, { kind: "message" }> =>
          e.kind === "message" && e.role === "user",
      )?.text ?? "";
      const advisory = formatAdvisory(
        await runAdvisor({
          task,
          script: p.script.body,
          perms,
          provider: p.ctx.advisorConfig,
        }),
      );
      if (advisory) p.ctx.ui.show(advisory);
    }
    outcome = await p.ctx.approve(p.script, perms);
  }

  if (outcome === "defer") {
    // Leave the proposal pending — no decision entry. The turn ends; a decision
    // arrives later via resumeTask (same or a fresh process), which folds the
    // pending script + perms back into a run.
    p.ctx.ui.status("deferred — awaiting a decision");
    p.outcome = "stop";
    return "done";
  }

  if (outcome === "reject") {
    p.ctx.log.push({
      kind: "decision",
      script: p.script.id,
      verdict: "reject",
      rationale: "rejected at review",
    });
    p.ctx.persist();
    p.ctx.ui.show("rejected.");
    p.outcome = "stop";
    return "done";
  }

  // A `{grant}` outcome approves THIS proposal and establishes a standing grant
  // for its perms — log the grant before the decision (its id is referenced for
  // audit/revocation).
  if (typeof outcome === "object") {
    const g = makeGrant(p.ctx.log, perms, Date.now(), outcome.grant.ttlMs);
    p.ctx.log.push(g);
    p.ctx.persist();
    p.ctx.ui.show(`· standing grant ${g.id} until ${g.expires}`);
  }

  p.ctx.log.push({
    kind: "decision",
    script: p.script.id,
    verdict: "approve",
    rationale: `approved with: ${perms.join(" ") || "(no perms)"}`,
  });
  p.ctx.persist();
  p.approved = true;
  return "continue";
};

/** Perform the approved script in the runner, log the result, apply net-output
 * gating, and set outcome. Terminal — always halts (done). */
export const run: Handler = async (p) => {
  // cwd not passed → performRun falls back to ctx.repo ?? its own scratch,
  // which is behavior-identical to the original (repo ?? run-scratch).
  p.outcome = await performRun({
    ctx: p.ctx,
    id: p.script.id,
    body: p.script.body,
    perms: fullPerms(p),
  });
  return "done";
};
