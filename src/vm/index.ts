// The VM launcher tier (sub-project B) — coarse outer isolation around the whole
// pagu process. Public surface for the `pagu vm` subcommand.
export { detectVM } from "./detect.ts";
export { wrapForVM } from "./wrap.ts";
export type { VMKind, VMMount, VMScope } from "./wrap.ts";
export { planVMLaunch } from "./plan.ts";
export type { VMLaunchOpts } from "./plan.ts";
export { modelHostFromBaseURL } from "./egress.ts";
