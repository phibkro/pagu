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
import { buildReview, formatReview } from "./review.ts";
import { formatAdvisory, runAdvisor } from "./advisor.ts";
import type { AgentContext, Responder, ScriptEntry } from "../context.ts";
import { isScript } from "../context.ts";
import type { Entry } from "../log/index.ts";
import type { Step } from "../loop.ts";

const MAX_FIX = 3;

/** The carrier threaded through the handler pipeline for one proposal. Mutable:
 * handlers read and mutate it (same style as the turn over ctx.log). `discovered`
 * + `initialBody` are the canonical state; `perms`/`discoveredPerms` derive. */
export interface Proposal {
  ctx: AgentContext;
  task: string;
  script: ScriptEntry; // mutated by the cage fix loop
  initialBody: string; // pre-cage body, for the review iteration diff
  discovered: string[]; // cage's absolutized perm output; [] until cage runs
  approved?: boolean;
  outcome: "stop" | "loop"; // the return to the turn loop; default "loop"
  respond: Responder; // the cage handler uses these for fix rounds
  showReply: (entries: Entry[]) => void;
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
    const fixed = await p.respond();
    p.ctx.log.push(...fixed);
    p.ctx.persist();
    p.showReply(fixed);
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
  const matchedSkill = matchesSkillScript(
    p.script.body,
    discoveredPerms,
    p.ctx.activeSkillScripts,
  );

  let approved: boolean;
  if (shouldAutoApprove(discoveredPerms, p.ctx.envelope, !!p.ctx.repo)) {
    p.ctx.ui.status("auto-approved (within session envelope)");
    approved = true;
  } else if (matchedSkill) {
    p.ctx.ui.status(`auto-approved (skill script: ${matchedSkill.name})`);
    approved = true;
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
      const advisory = formatAdvisory(
        await runAdvisor({
          task: p.task,
          script: p.script.body,
          perms,
          provider: p.ctx.advisorConfig,
        }),
      );
      if (advisory) p.ctx.ui.show(advisory);
    }
    approved = await p.ctx.approve(p.script, perms);
  }

  if (!approved) {
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
