// pure: the approval lifecycle's log-derived state. The gate is durable —
// proposed → pending → granted/denied/expired — and "pending" is *derived*, not
// stored: a `script` that reached the gate (a `perms` entry exists for it) with
// no following `decision`/`result` is pending. This fold is what a reconnecting
// client or a fresh process reads to know "a decision is needed."
// Full design: docs/specs/2026-05-29-async-approval-design.md.
import type { Entry, ScriptEntry } from "./log/schema.ts";

/** A proposal awaiting a human decision: the authored script + the full
 * permission set it was gated against (so a resumed run is faithful). */
export interface PendingProposal {
  script: ScriptEntry;
  perms: string[];
}

/**
 * The pending proposal, if any. The last proposed `script` is pending when it
 * reached the gate (a `perms` entry was written for it) and has not been
 * resolved (no `decision`) or run (no `result`). At most one is pending per
 * session by construction (the loop suspends at the first deferred gate).
 */
export function pendingProposal(log: Entry[]): PendingProposal | null {
  let script: ScriptEntry | null = null;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.kind === "script") {
      script = e;
      break;
    }
  }
  if (!script) return null;
  const id = script.id;
  const resolved = log.some(
    (e) => (e.kind === "decision" || e.kind === "result") && e.script === id,
  );
  if (resolved) return null;
  const perms = log.find((e) => e.kind === "perms" && e.script === id);
  if (!perms || perms.kind !== "perms") return null; // gate not yet reached
  return { script, perms: perms.perms };
}
