// Shared application-boundary types. These are the "ports" in hexagonal
// terms: interfaces that define how frontends drive the core, and how the
// core exposes its state. Extracted here so capability modules can import
// AgentContext without creating a circular dependency with agent.ts.
import type { ConcealmentSpec, Envelope } from "./permissions/index.ts";
import type { SandboxKind } from "./runner/index.ts";
import type { Entry } from "./log/index.ts";
import type { ProviderConfig } from "./providers/index.ts";
import type { SessionMeta } from "./config/index.ts";
import type { HandlerPlugin } from "./capability/index.ts";
import type { EventStream } from "./events.ts";
import type { SkillScript } from "./skills/index.ts";
import type { CommandEntry, DiscoveredTask } from "./tasks/index.ts";
import type { CommandRule } from "./tasks/grammar.ts";

// ── Entry type aliases used across capability modules ──────────────────────

export type ScriptEntry = Extract<Entry, { kind: "script" }>;
export const isScript = (e: Entry): e is ScriptEntry => e.kind === "script";

export type SkillInvocationEntry = Extract<Entry, { kind: "skill-invoke" }>;
export const isSkillInvoke = (e: Entry): e is SkillInvocationEntry =>
  e.kind === "skill-invoke";

export type CommandInvocationEntry = Extract<Entry, { kind: "command-invoke" }>;
export const isCommandInvoke = (e: Entry): e is CommandInvocationEntry =>
  e.kind === "command-invoke";

// ── Port interfaces ─────────────────────────────────────────────────────────

/** What a human can answer at the gate _now_: approve · reject · **defer**
 * ("not now" — persist the proposal as pending and end the turn; a decision
 * arrives later via `resumeTask`) · **`{grant}`** (approve this _and_ establish a
 * standing approval for its perms for `ttlMs` — see standing approvals). Distinct
 * from a logged `Decision.verdict` (`approve | reject | expired`): `defer` is the
 * *absence* of a decision, `expired` is system-generated. See the approval
 * lifecycle in `docs/CONCEPTS.md` and the specs under `docs/specs/`. */
export type ApprovalOutcome =
  | "approve"
  | "reject"
  | "defer"
  | { grant: { ttlMs: number } };

/** The one I/O seam for the human review gate (stdin / TUI prompt / remote).
 * Only called when a proposal is NOT auto-approvable. The perms it would run
 * with are already shown by the core; the approver returns an outcome. A
 * synchronous frontend (CLI/TUI) answers approve/reject; a detached one may
 * `defer`. */
export type Approver = (
  script: ScriptEntry,
  perms: string[],
) => Promise<ApprovalOutcome>;

/** Output sink: `status` for transient progress, `show` for results. An
 * optional `stream` consumes live display chunks; if present, the core lets
 * the stream render the assistant's text instead of re-printing it. The
 * `channel` distinguishes the answer (`content`) from `reasoning` and activity
 * `marker`s, so a frontend can render them differently (ACP thought chunks,
 * TUI dimming). Defaults to `content`; an implementer may ignore it. */
export interface UI {
  status(msg: string): void;
  show(msg: string): void;
  stream?(chunk: string, channel?: "content" | "reasoning" | "marker"): void;
  /** Entries just appended to the log — lets a frontend surface actions
   * (the ACP frontend maps them to tool calls; CLI/TUI omit it). */
  entries?(produced: Entry[]): void;
}

/** A function that runs the respond phase and returns the entries it produced.
 * Passed into capability execute functions so they can trigger a fix round. */
export type Responder = () => Promise<Entry[]>;

// ── Application context ─────────────────────────────────────────────────────

/** The I/O-agnostic application context. Frontends build one and pass it to
 * runTask; the core reads it every turn but never depends on the frontend. */
export interface AgentContext {
  provider: ProviderConfig;
  providerHost: string;
  /** Switch provider/model at runtime; returns a status line to display. */
  setProvider: (
    change: { provider?: string; model?: string; baseURL?: string },
  ) => { ok: boolean; message: string };
  /** The active provider preset name (reflects roles/flags + /provider). */
  providerName: () => string;
  /** The provider's available model ids, cached — empty until the first
   * `fetchModels`, cleared on a provider switch. */
  models: () => string[];
  /** Re-fetch the provider's models in a net-scoped subprocess and refresh the
   * cache (the orchestrator itself stays net-less). */
  fetchModels: () => Promise<string[]>;
  /** Project dir (git root, else cwd) where roles are discovered. */
  projectBase: string;
  /** Names of the currently applied roles, in compose order. */
  roleNames: () => string[];
  /** Roles discoverable at this project/global scope (for `/roles` listing,
   * over any frontend — the ACP text form doesn't have the TUI picker). */
  availableRoles: () => Promise<{ name: string; scope: string }[]>;
  /** Set the active role group at runtime: re-folds config and re-derives
   * permissions/prose. Fails loud (state unchanged) on an unknown name. */
  setRoles: (names: string[]) => Promise<{ ok: boolean; message: string }>;
  phaseDir: string;
  agents: string;
  readPaths: string[];
  repo?: string;
  readonly envelope: Envelope;
  denyFlags: string[];
  /** The concealment policy spec — VCS paths + hide/reveal/secret globs that
   * fold into the predicate (agent read-refusal, CF3) and the runner mask via
   * buildConcealment(conceal). */
  conceal: ConcealmentSpec;
  /** Explicit command policy entries (from allowed-tasks config + inferred). */
  commandEntries: CommandEntry[];
  /** Discovered project tasks (for the run_task tool listing). */
  discoveredTasks: DiscoveredTask[];
  /** Default read-only command rules whose program is installed here — the
   * run_command tool advertises these (legal ∩ available). */
  availableCommandRules: CommandRule[];
  /** Pre-approved scripts from active skills. */
  activeSkillScripts: SkillScript[];
  /** Skills discoverable at this project/global scope (for `/skills` listing). */
  availableSkills: () => Promise<{ name: string; scope: string }[]>;
  /** Loaded before-approve handlers; empty when none configured. */
  activeHandlers: HandlerPlugin[];
  /** Replace the active skill group at runtime (the TUI's /skills). */
  setSkills: (names: string[]) => Promise<{ ok: boolean; message: string }>;
  /** Advisory reviewer config — present = enabled, absent = disabled. */
  advisorConfig?: ProviderConfig;
  /** Toggle advisor on/off and optionally reconfigure its provider/model. */
  setAdvisor: (
    change: { enabled?: boolean; provider?: string; model?: string },
  ) => { ok: boolean; message: string };
  /** A description of what authored scripts can actually do. */
  capabilities: string;
  /** OS sandbox tier wrapping every run (bubblewrap / sandbox-exec / none). */
  sandboxKind: SandboxKind;
  /** The active conversation — append events here; call persist to save. */
  log: Entry[];
  persist: () => void;
  /** The addressable/streamable read side of the log: a subscriber asks for
   * everything after an offset, then tails. `persist` wakes it (the single
   * notify chokepoint). The markdown stays the source-of-truth projection. */
  events: EventStream;
  sessionBase: string;
  currentLogPath: () => string;
  /** Repoint to another session, replacing the live log in place (the
   * primitive; the high-level ops below are built on it). */
  switchSession: (path: string, entries: Entry[], meta: SessionMeta) => void;
  /** Start a fresh empty session (materialized on first write). */
  newSession: (now: Date) => void;
  /** Branch the active conversation into a fresh session, materialized now. */
  forkSession: (now: Date) => void;
  /** Open a stored session by path, replacing the live log. */
  openSession: (path: string) => Promise<void>;
  rename: (name: string) => void;
  ui: UI;
  approve: Approver;
  /** Re-invoke the respond phase. Injected by agent.ts before the turn loop
   *  (same DI pattern as approve — the Application layer can't construct this
   *  itself without importing from the Adapters layer). */
  respond: Responder;
}
