// pure: matchesPolicy, buildExplicitEntries; effects: loadInferred, saveInferred
import { join } from "@std/path";

/**
 * A pre-approved command invocation. The permissions field is the ceiling:
 * the cage may discover any subset and auto-approve; anything outside triggers
 * the human gate.
 *
 * source "explicit" — declared by the user in config (permanent).
 * source "inferred" — cage-discovered on first run, stored in
 *   .pagu/inferred-perms.json. Acts as the type-inferred ceiling; re-derives
 *   when the project config changes or the user invalidates it.
 */
export interface CommandEntry {
  program: string;
  args: string[];
  permissions: string[];
  source: "explicit" | "inferred";
  /** ISO timestamp set when permissions were cage-inferred. */
  inferredAt?: string;
  /** Absolute path to the file that defines this task. Used to detect
   * staleness: if the file is newer than inferredAt, re-discover. */
  sourceFile?: string;
}

export interface DiscoveredTask {
  program: string;
  args: string[];
  description: string;
  /** Absolute path to the file that defines this task (e.g. deno.json).
   * Used for staleness checks: when this file changes, the inferred
   * permission ceiling for the task is re-discovered on next cage run. */
  sourceFile: string;
}

/**
 * Filter inferred entries whose source file has been modified since the
 * permissions were inferred. Stale entries are discarded — the cage will
 * re-discover on the next run_task invocation and store a fresh ceiling.
 */
export async function filterStaleInferred(
  entries: CommandEntry[],
): Promise<CommandEntry[]> {
  const results: CommandEntry[] = [];
  for (const e of entries) {
    if (e.source === "explicit" || !e.sourceFile || !e.inferredAt) {
      results.push(e);
      continue;
    }
    try {
      const stat = await Deno.stat(e.sourceFile);
      const fileMs = stat.mtime?.getTime() ?? 0;
      const inferredMs = new Date(e.inferredAt).getTime();
      if (fileMs <= inferredMs) results.push(e); // still fresh
      // else: stale — drop it, will re-infer on next run
    } catch {
      results.push(e); // file gone? keep entry, fail later
    }
  }
  return results;
}

/** Pure: find a policy entry matching this exact program + args. */
export function matchesPolicy(
  program: string,
  args: string[],
  entries: CommandEntry[],
): CommandEntry | undefined {
  return entries.find(
    (e) =>
      e.program === program &&
      e.args.length === args.length &&
      e.args.every((a, i) => a === args[i]),
  );
}

/**
 * Parse a list of "program arg1 arg2 …" strings (from config) into explicit
 * CommandEntry objects with an empty permissions list (cage-inferred on first
 * run). Skips blank / whitespace-only entries.
 */
export function buildExplicitEntries(commands: string[]): CommandEntry[] {
  return commands.flatMap((cmd) => {
    const parts = cmd.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return [];
    const [program, ...args] = parts;
    return [{ program, args, permissions: [], source: "explicit" as const }];
  });
}

const INFERRED_FILE = ".pagu/inferred-perms.json";

/** Load cage-inferred permission entries from the project's lockfile. */
export async function loadInferred(
  projectBase: string,
): Promise<CommandEntry[]> {
  try {
    const text = await Deno.readTextFile(join(projectBase, INFERRED_FILE));
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as CommandEntry[]) : [];
  } catch {
    return [];
  }
}

/** Persist cage-inferred entries to the project's lockfile. */
export async function saveInferred(
  projectBase: string,
  entries: CommandEntry[],
): Promise<void> {
  const path = join(projectBase, INFERRED_FILE);
  await Deno.mkdir(join(projectBase, ".pagu"), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(entries, null, 2) + "\n");
}

/**
 * Upsert an inferred entry: replace an existing matching entry, or append.
 * Call after a successful cage run to store the discovered ceiling.
 */
export async function storeInferred(
  projectBase: string,
  entry: CommandEntry,
): Promise<void> {
  const existing = await loadInferred(projectBase);
  const idx = existing.findIndex(
    (e) =>
      e.program === entry.program &&
      e.args.length === entry.args.length &&
      e.args.every((a, i) => a === entry.args[i]),
  );
  if (idx >= 0) {
    existing[idx] = entry;
  } else {
    existing.push(entry);
  }
  await saveInferred(projectBase, existing);
}
