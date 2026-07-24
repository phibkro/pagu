/**
 * pagu's surviving security-organ API after the pre-1.0 sandbox + gate pivot.
 *
 * The integrated model harness is archived at `archive/harness` and the
 * `harness-final` tag. This module now exposes only the reusable approval,
 * capability-ceiling, policy/config, event-log, and sandbox seams that seed the
 * gate. The pivot intentionally breaks the former harness API (ADR-0004).
 */

// Approval lifecycle and standing grants.
export {
  activeGrantEntries,
  activeGrants,
  isExpired,
  makeGrant,
  pendingProposal,
  submitDecision,
} from "./approval.ts";
export { deferApproval } from "./approval.ts";
export type {
  ApprovalOutcome,
  Approver,
  DecisionSubmission,
  PendingProposal,
} from "./approval.ts";

// Fail-closed capability-ceiling validation.
export { validateCeiling } from "./capability/index.ts";

// Layered policy configuration and untrusted-project narrowing.
export { composeLayers, mergeLayer, toLayer } from "./config/config.ts";
export type { ConfigLayer } from "./config/config.ts";
export {
  loadProjectConfig,
  sanitizeProjectLayer,
} from "./config/project-config.ts";

// Human/agent launch defaults and harness inference.
export * from "./launch/index.ts";

// Request-only inhabitant MCP surface.
export * from "./mcp/index.ts";

// Event store and addressable event stream.
export * from "./log/index.ts";
export { eventStream } from "./events.ts";
export type { EventStream, Indexed } from "./events.ts";

// Permission/envelope and concealment primitives.
export * from "./permissions/index.ts";

// OS sandbox detection and command construction.
export { detectSandbox, wrapForSandbox } from "./runner/sandbox.ts";
export type { SandboxKind, SandboxScope } from "./runner/sandbox.ts";

// Versioned standing policy / grant schema and pure policy compiler.
export * from "./policy/index.ts";

// Credential/namespace-aware child-host broker core.
export * from "./child/index.ts";

// Sandbox request SDK and outside-sandbox gate ports.
export * from "./request/index.ts";
export * from "./gate/index.ts";

// Versioned read-only projection over gate event logs.
export * from "./telemetry/index.ts";
