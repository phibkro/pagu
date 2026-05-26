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
  | PermsEntry
  | Decision
  | ResultEntry;

/** A conversational turn (the user's task, or the model's prose). */
export interface Message {
  kind: "message";
  role: "user" | "assistant";
  text: string;
}

/** What a read (Observe phase) returned. `source` is e.g. "fs:./photos". */
export interface Observation {
  kind: "observation";
  source: string;
  content: string;
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
