// effects: assemble + run the write-capability handler pipeline.
import { pipeline } from "../loop.ts";
import { approve, cage, type Proposal, run } from "./pipeline.ts";
import type { AgentContext, Responder, ScriptEntry } from "../context.ts";
import type { Entry } from "../log/index.ts";

/**
 * Run the write-capability pipeline for an agent-authored script:
 *   cage self-test (with up to MAX_FIX fix rounds) → approval gate → run.
 *
 * Composed from named handlers (see ./pipeline.ts) via `pipeline`; the
 * cage → approve → run sequence and its control flow are unchanged. Returns
 * "stop" to exit runTask, "loop" to continue to the next turn. `respond` lets
 * the cage fix loop repair a buggy script; `showReply` surfaces chat text.
 */
export async function executeScriptProposal(
  script: ScriptEntry,
  task: string,
  ctx: AgentContext,
  respond: Responder,
  showReply: (entries: Entry[]) => void,
): Promise<"stop" | "loop"> {
  const proposal: Proposal = {
    ctx,
    task,
    script,
    initialBody: script.body,
    discovered: [],
    outcome: "loop",
    respond,
    showReply,
  };
  await pipeline([cage, approve, run])(proposal);
  return proposal.outcome;
}
