// pure: verified broker evidence to canonical append-only event.
import type { ChildLaunchEntry } from "../log/schema.ts";
import type { ChildLaunchEvidenceV0 } from "./broker.ts";

/** Copy verified launch material into the event-store wire shape. */
export function childLaunchEntry(
  evidence: ChildLaunchEvidenceV0,
  at?: string,
): ChildLaunchEntry {
  return {
    kind: "child-launch",
    version: 0,
    ...(at ? { at } : {}),
    id: evidence.id,
    parent: evidence.parent,
    depth: evidence.depth,
    host: evidence.host,
    parentPolicy: evidence.parentPolicy,
    policy: evidence.policy,
    requestRoute: evidence.requestRoute,
    pid: evidence.pid,
    namespace: evidence.namespace,
    cwd: evidence.cwd,
    command: [...evidence.command],
    argv: [...evidence.argv],
    environment: [...evidence.environment],
  };
}
