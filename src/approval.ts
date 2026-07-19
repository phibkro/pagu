// pure: the approval lifecycle's log-derived state. The gate is durable —
// proposed → pending → granted/denied/expired — and "pending" is *derived*, not
// stored: a `script` that reached the gate (a `perms` entry exists for it) with
// no following `decision`/`result` is pending. This fold is what a reconnecting
// client or a fresh process reads to know "a decision is needed."
// Full design: docs/specs/2026-05-29-async-approval-design.md.
import type { Decision, Entry, GrantEntry, ScriptEntry } from "./log/schema.ts";
import { parsePermission, type PermissionSet } from "./permissions/index.ts";

/** What a human gate may decide now. `defer` records no decision; a tagged
 * grant approves once and asks the gate to establish a time-boxed standing
 * grant for the proposal's exact permissions. */
export type ApprovalOutcome =
  | "approve"
  | "reject"
  | "defer"
  | { kind: "grant"; ttlMs: number };

/** Human-review port. The gate owns the decision; callers may present it via a
 * terminal, TUI, remote queue, or another adapter without changing the core. */
export type Approver = (
  script: ScriptEntry,
  perms: readonly string[],
) => Promise<ApprovalOutcome>;

/** The detached gate posture: leave the proposal pending for later review. */
export const deferApproval: Approver = () => Promise.resolve("defer");

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
export function pendingProposal(log: readonly Entry[]): PendingProposal | null {
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

/**
 * Construct the next `grant` entry (pure): id = `g<n+1>` by existing grant count,
 * absolute `expires = nowMs + ttlMs`, carrying `perms` verbatim. The effectful
 * caller (the gate / resume) pushes + persists it; the orchestrator supplies
 * `nowMs` (`Date.now()`) so this stays pure and testable.
 */
export function makeGrant(
  log: readonly Entry[],
  perms: string[],
  nowMs: number,
  ttlMs: number,
): GrantEntry {
  const n = log.filter((e) => e.kind === "grant").length + 1;
  return {
    kind: "grant",
    id: `g${n}`,
    perms,
    expires: new Date(nowMs + ttlMs).toISOString(),
  };
}

/**
 * The standing approvals in force at `nowMs`, each as a parsed allow-set. A
 * `grant` is active iff its `expires` is in the future **and** no `revoke`
 * references its id. Fail-safe: a grant with an unparseable expiry or perm grants
 * nothing (it folds out) — a malformed log can only ever narrow authority. The
 * auto-approve gate checks each against the session deny (see `shouldAutoApprove`).
 */
export function activeGrants(
  log: readonly Entry[],
  nowMs: number,
): PermissionSet[] {
  return activeGrantEntries(log, nowMs).flatMap((g) => {
    try {
      return [g.perms.map(parsePermission)];
    } catch {
      return []; // a malformed grant grants nothing
    }
  });
}

/** The active `grant` entries (id/perms/expires) — for display (`/grants`) and
 * as the source `activeGrants` parses. Active = unexpired (a valid future
 * `expires`) and not referenced by any `revoke`. */
export function activeGrantEntries(
  log: readonly Entry[],
  nowMs: number,
): GrantEntry[] {
  const revoked = new Set(
    log.flatMap((e) => e.kind === "revoke" ? [e.grant] : []),
  );
  return log.filter((e): e is GrantEntry =>
    e.kind === "grant" && !revoked.has(e.id) &&
    new Date(e.expires).getTime() > nowMs
  );
}

/** Whether a pending proposal of age `ageMs` has outlived `ttlMs`. A
 * non-positive TTL disables expiry (a pending proposal then persists until
 * answered). Pure — the frontend supplies the age (now − session mtime). */
export function isExpired(ageMs: number, ttlMs: number): boolean {
  return ttlMs > 0 && ageMs > ttlMs;
}

/** Result of submitting a decision for a specific pending proposal. A resolved
 * submission returns the event for the single writer to append; stale/wrong
 * submissions return no event and therefore cannot create authority. */
export type DecisionSubmission =
  | { status: "resolved"; decision: Decision }
  | { status: "not-pending" | "id-mismatch" };

/**
 * Proposal-ID-bound, resolve-only write-back seam for detached gate adapters.
 * Pure and idempotent over the log: it cannot author a proposal, change its
 * permissions, or append anything itself. The gate's single writer appends the
 * returned decision event, after which a repeat submission is `not-pending`.
 */
export function submitDecision(
  log: readonly Entry[],
  proposalId: string,
  verdict: "approve" | "reject",
): DecisionSubmission {
  const pending = pendingProposal(log);
  if (!pending) return { status: "not-pending" };
  if (pending.script.id !== proposalId) return { status: "id-mismatch" };
  return {
    status: "resolved",
    decision: {
      kind: "decision",
      script: proposalId,
      verdict,
      rationale: verdict === "approve"
        ? `approved with: ${pending.perms.join(" ") || "(no perms)"}`
        : "rejected",
    },
  };
}
