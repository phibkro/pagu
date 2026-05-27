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
  | ResultEntry;

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

/** A human (or auto-approve rule) decision on a proposed script. */
export interface Decision {
  kind: "decision";
  script: string;
  verdict: "approve" | "reject";
  rationale: string;
}

/** The outcome of running an approved script in the sandboxed runner. */
export interface ResultEntry {
  kind: "result";
  script: string;
  exit: number;
  ranWith: string[]; // the exact flags the runner used
  output: string;
}
