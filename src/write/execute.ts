// effects: assemble + run the write-capability handler pipeline.
import { pipeline } from "../loop.ts";
import { approve, cage, type Proposal, run } from "./pipeline.ts";
import type { AgentContext, ScriptEntry } from "../context.ts";

/**
 * Run the write-capability pipeline for an agent-authored script:
 *   cage self-test (with up to MAX_FIX fix rounds) → approval gate → run.
 *
 * respond is read from ctx (DI'd by agent.ts); task is derived from ctx.log;
 * showReply is inlined from ctx.ui in the cage handler.
 */
export async function executeScriptProposal(
  script: ScriptEntry,
  ctx: AgentContext,
): Promise<"stop" | "loop"> {
  const proposal: Proposal = {
    ctx,
    script,
    initialBody: script.body,
    discovered: [],
    outcome: "loop",
  };
  await pipeline([cage, approve, run])(proposal);
  return proposal.outcome;
}
