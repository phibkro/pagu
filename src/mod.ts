/**
 * pagu — the stable public API: the one front door for embedding pagu in your
 * own program.
 *
 * **Stability.** The exports here are frozen — no backwards-incompatible change
 * (removal / rename / kind-change) while on v1; *additions* are fine. The floor
 * test in `mod.test.ts` enforces this in CI. Everything NOT re-exported here is
 * internal and may change without notice — import only from this module.
 *
 * **Shape.** Build a frontend with {@link createContext} + your own
 * {@link UI}/{@link Approver}, then drive {@link runTask}; compose your own
 * loops with the combinators ({@link loop}/{@link andThen}/{@link pipeline}/
 * {@link fanOut}); inject before-approve handlers via
 * `createContext({ handlers })`. The capability set is **closed** —
 * {@link Capability} is exposed as a type for reference, not for defining new
 * agent tools (invariant #1: the blast radius stays statically enumerable).
 */

// Core loop & ports
export {
  resumePending,
  resumeTask,
  runTask,
  scheduledRun,
  submitDecision,
} from "./agent.ts";
export type {
  AgentContext,
  ApprovalOutcome,
  Approver,
  Budget,
  UI,
} from "./agent.ts";

// Loop combinators (pure, lawful)
export { andThen, fanOut, loop, pipeline } from "./loop.ts";
export type { Flow, Step } from "./loop.ts";

// Construction — the hermetic programmatic constructor
export { createContext } from "./config/setup.ts";

// Extension point + reference types
export type { Capability, HandlerPlugin } from "./capability/index.ts";
export type { Entry } from "./log/index.ts";
export type { ScriptEntry } from "./context.ts";

// Event stream — the addressable/streamable read side of the log, and the first
// projection over it (CONTEXT → State model / #14). Subscribe from an offset,
// then tail; fold the stream into your own views.
export { eventStream } from "./events.ts";
export type { EventStream, Indexed } from "./events.ts";
export { observe } from "./observe.ts";
export type { ObservabilitySummary } from "./observe.ts";
