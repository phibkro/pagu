// pure: event-log types
/**
 * A pagu conversation log is an ordered, append-only sequence of Entries,
 * serialized as tilde-fenced markdown blocks (`~~~pagu:<kind> attrs`).
 * Tilde fences (not backtick) so script bodies containing ``` survive
 * round-trips. This is the single canonical artifact (the event store);
 * each phase folds it and appends.
 */
export type Entry =
  | Message
  | Observation
  | ScriptEntry
  | SkillInvocationEntry
  | CommandInvocationEntry
  | PermsEntry
  | Decision
  | ResultEntry
  | GrantEntry
  | RevokeEntry
  | GateSessionEntry
  | FileRequestEntry
  | RequestDecisionEntry
  | PolicyGrantEntry
  | PolicyLaunchEntry
  | PolicyLaunchFailedEntry
  | PolicyGrantSpentEntry;

/** Versioned gate-run metadata. Later request events inherit the most recent
 * metadata in their log; the event keeps telemetry a projection of the
 * canonical append-only store rather than a parallel metadata database. */
export interface GateSessionEntry {
  kind: "gate-session";
  version: 0;
  at: string;
  session: string;
  profile: string | null;
  subjectAgent: string;
  subjectLabel: string;
}

/** A sandbox-originated request. The gate allocates `id` before append. */
export interface FileRequestEntry {
  kind: "request";
  /** ISO timestamp; absent only in logs written before telemetry v0. */
  at?: string;
  id: string;
  need: string;
  justification: string;
  fsRo: string;
}

/** The gate's tiered decision for an addressable request. */
export interface RequestDecisionEntry {
  kind: "request-decision";
  at?: string;
  request: string;
  verdict: "approve" | "deny";
  scope: "once" | "session" | "persist" | null;
  tier: "refuse" | "auto" | "operator";
  rationale: string;
}

/** Evidence that an approved request produced a gate-owned policy grant. */
export interface PolicyGrantEntry {
  kind: "policy-grant";
  at?: string;
  id: string;
  request: string;
  scope: "once" | "session" | "persist";
  fsRo: string;
  canonicalFsRo: string;
  session: string;
  authority: string;
  policy: string;
}

/** Evidence from the box adapter that spawned the actual compiled launch. */
export interface PolicyLaunchEntry {
  kind: "policy-launch";
  at?: string;
  id: string;
  grant: string | null;
  session: string;
  policy: string;
  cwd: string;
  pid: number;
  resume: string[];
  argv: string[];
  environment: string[];
}

/** A loud application/commit failure; any provisional child is rolled back. */
export interface PolicyLaunchFailedEntry {
  kind: "policy-launch-failed";
  at?: string;
  grant: string;
  session: string;
  reason: string;
}

/** Durable consumption marker for an at-most-once launch grant. */
export interface PolicyGrantSpentEntry {
  kind: "policy-grant-spent";
  at?: string;
  grant: string;
  session: string;
}

/** A conversational turn (the user's task, or the model's prose). */
export interface Message {
  kind: "message";
  role: "user" | "assistant";
  text: string;
}

/** What a read returned. `source` records the command that ran — e.g.
 * "read ./notes.md" or "ls ./photos" — so the log audits actions, not just
 * their output. ("error" for a failed read.) */
export interface Observation {
  kind: "observation";
  source: string;
  content: string;
}

/** The agent chose to run a pre-approved project task or allowed command.
 * The orchestrator validates against the command policy (explicit + inferred),
 * cages to discover/verify permissions, stores the ceiling, then runs. */
export interface CommandInvocationEntry {
  kind: "command-invoke";
  id: string;
  program: string;
  args: string[];
}

/** The agent chose to invoke a pre-approved skill script by name. The
 * orchestrator resolves the body from activeSkillScripts — the agent never
 * authors or copies the script content. args are passed to the runner at
 * execution time; all dynamic behaviour is encoded as script inputs. */
export interface SkillInvocationEntry {
  kind: "skill-invoke";
  id: string;
  /** Name of the pre-approved skill script. */
  script: string;
  /** Optional arguments passed to the runner. */
  args?: string[];
}

/** A script the model proposed (Author phase). Never executed by the agent. */
export interface ScriptEntry {
  kind: "script";
  id: string;
  lang: string;
  body: string;
}

/** Permissions discovered for a script by the zero-permission run. */
export interface PermsEntry {
  kind: "perms";
  script: string; // ScriptEntry.id
  perms: string[]; // e.g. ["allow-read=./photos"]
}

/** A human (or auto-approve rule) decision on a proposed script. `expired` is a
 * terminal verdict the system records when a pending proposal outlives its TTL
 * (no human answer in time) — see the approval lifecycle. */
export interface Decision {
  kind: "decision";
  script: string;
  verdict: "approve" | "reject" | "expired";
  rationale: string;
}

/** A standing approval: a human-authored, time-boxed **allow**-set (not an
 * Envelope — no deny of its own). While active (`now < expires` and not revoked)
 * the auto-approve gate honors `perms` as additional allow-coverage, evaluated
 * against the session's deny. See the standing-approvals design. */
export interface GrantEntry {
  kind: "grant";
  id: string; // "g1", "g2", … — addressable for revocation
  perms: string[]; // the authorized allow-set
  expires: string; // absolute ISO time
}

/** Ends a `grant` early — the append-only inverse (never mutate the grant). */
export interface RevokeEntry {
  kind: "revoke";
  grant: string; // the GrantEntry.id being revoked
}

/** The outcome of running an approved script in the sandboxed runner. */
export interface ResultEntry {
  kind: "result";
  script: string;
  exit: number;
  ranWith: string[]; // the exact flags the runner used
  output: string;
  /** OS sandbox tier that wrapped the run — present for runs after this was
   *  added to the schema; absent in older session logs. */
  sandbox?: "bwrap" | "sandbox-exec" | "none";
}
