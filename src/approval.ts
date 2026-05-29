// pure: the approval lifecycle's log-derived state. The gate is durable —
// proposed → pending → granted/denied/expired — and "pending" is *derived*, not
// stored: a `script` that reached the gate (a `perms` entry exists for it) with
// no following `decision`/`result` is pending. This fold is what a reconnecting
// client or a fresh process reads to know "a decision is needed."
// Full design: docs/specs/2026-05-29-async-approval-design.md.
import type { Entry, GrantEntry, ScriptEntry } from "./log/schema.ts";
import { parsePermission, type PermissionSet } from "./permissions/index.ts";

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

/**
 * Construct the next `grant` entry (pure): id = `g<n+1>` by existing grant count,
 * absolute `expires = nowMs + ttlMs`, carrying `perms` verbatim. The effectful
 * caller (the gate / resume) pushes + persists it; the orchestrator supplies
 * `nowMs` (`Date.now()`) so this stays pure and testable.
 */
export function makeGrant(
  log: Entry[],
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
export function activeGrants(log: Entry[], nowMs: number): PermissionSet[] {
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
export function activeGrantEntries(log: Entry[], nowMs: number): GrantEntry[] {
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
