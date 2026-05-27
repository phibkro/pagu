// effects: cage (with fix loop) + review + advisory + approval gate + run
import { absolutizePerm, parsePermission } from "../permissions/index.ts";
import { shouldAutoApprove } from "../permissions/index.ts";
import { classifyRun, runScript } from "../runner/index.ts";
import { matchesSkillScript } from "../skills/index.ts";
import { buildReview, formatReview } from "./review.ts";
import { formatAdvisory, runAdvisor } from "./advisor.ts";
import type { AgentContext, Responder, ScriptEntry } from "../context.ts";
import { isScript } from "../context.ts";

const MAX_FIX = 3;

/**
 * Run the full write-capability pipeline for an agent-authored script:
 *   cage self-test (with up to MAX_FIX fix rounds) →
 *   review display + advisory →
 *   approval gate (auto or human) →
 *   run
 *
 * Returns "stop" to exit runTask, "loop" to continue to the next turn.
 * `respond` is passed in so the fix loop can ask the model to repair a
 * buggy script. `showReply` surfaces any chat text the model emits.
 */
export async function executeScriptProposal(
  script: ScriptEntry,
  task: string,
  ctx: AgentContext,
  respond: Responder,
  showReply: (entries: import("../log/index.ts").Entry[]) => void,
): Promise<"stop" | "loop"> {
  const initialBody = script.body;
  let current = script;
  const base = ctx.repo ?? Deno.cwd();

  // Cage self-test with fix loop
  let discovered: string[] = [];
  for (let attempt = 1; attempt <= MAX_FIX; attempt++) {
    const scratch = await Deno.makeTempDir({ prefix: "pagu-cage-" });
    const file = `${scratch}/${current.id}.ts`;
    await Deno.writeTextFile(file, current.body);
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
      text: `Sandbox self-test of ${current.id} failed:\n${
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
    current = next;
  }

  discovered = discovered.map((s) => absolutizePerm(s, base));
  const perms = [
    ...ctx.readPaths.map((p) => `allow-read=${p}`),
    ...discovered,
  ];

  // Approval gate
  const discoveredPerms = discovered.map(parsePermission);
  const matchedSkill = matchesSkillScript(
    current.body,
    discoveredPerms,
    ctx.activeSkillScripts,
  );

  let approved: boolean;
  if (shouldAutoApprove(discoveredPerms, ctx.envelope, !!ctx.repo)) {
    ctx.ui.status("auto-approved (within session envelope)");
    approved = true;
  } else if (matchedSkill) {
    ctx.ui.status(`auto-approved (skill script: ${matchedSkill.name})`);
    approved = true;
  } else {
    const review = buildReview({
      perms,
      envelope: ctx.envelope,
      body: current.body,
      prevBody: current.body !== initialBody ? initialBody : undefined,
    });
    ctx.ui.show(
      formatReview(review, current.id, current.lang, current.body),
    );
    if (ctx.advisorConfig) {
      const advisory = formatAdvisory(
        await runAdvisor({
          task,
          script: current.body,
          perms,
          provider: ctx.advisorConfig,
        }),
      );
      if (advisory) ctx.ui.show(advisory);
    }
    approved = await ctx.approve(current, perms);
  }

  if (!approved) {
    ctx.log.push({
      kind: "decision",
      script: current.id,
      verdict: "reject",
      rationale: "rejected at review",
    });
    ctx.persist();
    ctx.ui.show("rejected.");
    return "stop";
  }

  ctx.log.push({
    kind: "decision",
    script: current.id,
    verdict: "approve",
    rationale: `approved with: ${perms.join(" ") || "(no perms)"}`,
  });
  ctx.persist();

  const scratch = await Deno.makeTempDir({ prefix: "pagu-run-" });
  const file = `${scratch}/${current.id}.ts`;
  await Deno.writeTextFile(file, current.body);
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
    script: current.id,
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
    return "stop";
  }
  return "loop";
}
