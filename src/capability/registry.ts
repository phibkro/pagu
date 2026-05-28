// pure: the single declaration point for all action capabilities.
// Adding a new capability = implement with `satisfies Capability<Data>`,
// add one line to this array. agent.ts never changes (generic dispatch).
import { writeCapability } from "../write/capability.ts";
import { skillCapability } from "../skills/capability.ts";
import {
  runCommandCapability,
  runTaskCapability,
} from "../tasks/capability.ts";
import type { Entry } from "../log/index.ts";

// `as const` preserves literal entryKind types so ActionEntryKind derives.
export const actionCapabilities = [
  writeCapability,
  skillCapability,
  runCommandCapability,
  runTaskCapability,
] as const;

// ActionEntryKind + ActionEntry + isActionEntry are derived from the registry
// automatically — adding a capability keeps them correct without extra edits.
type ActionEntryKind = (typeof actionCapabilities)[number]["entryKind"];
export type ActionEntry = Extract<Entry, { kind: ActionEntryKind }>;

export function isActionEntry(e: Entry): e is ActionEntry {
  return actionCapabilities.some((c) => c.entryKind === e.kind);
}
