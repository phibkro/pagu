// pure: the observability projection — a fold over the event log selecting the
// security/activity-relevant facts. The point pagu's State model makes: a trace
// / audit / cost feed is a *filtered projection of the one log*, not a parallel
// pipeline. This is the first such subscriber (CONTEXT #14); it consumes the
// EventStream like any other and folds what it receives.
import type { Entry } from "./log/schema.ts";

/** A run's activity + safety summary, folded from its events. */
export interface ObservabilitySummary {
  events: number;
  reads: number; // successful read observations
  approvals: number; // human/auto approve decisions
  rejections: number; // reject decisions
  runs: number; // scripts actually executed (result entries)
  failures: number; // runs that exited non-zero
  netGranted: boolean; // any run was granted network (the exfil-relevant fact)
}

const NET = /--allow-(net|all)\b/;

export function observe(entries: Entry[]): ObservabilitySummary {
  const s: ObservabilitySummary = {
    events: entries.length,
    reads: 0,
    approvals: 0,
    rejections: 0,
    runs: 0,
    failures: 0,
    netGranted: false,
  };
  for (const e of entries) {
    switch (e.kind) {
      case "observation":
        if (e.source !== "error") s.reads++;
        break;
      case "decision":
        if (e.verdict === "approve") s.approvals++;
        else s.rejections++;
        break;
      case "result":
        s.runs++;
        if (e.exit !== 0) s.failures++;
        if (e.ranWith.some((f) => NET.test(f))) s.netGranted = true;
        break;
    }
  }
  return s;
}
