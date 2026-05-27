// effects: filesystem (session store); pure: path + id helpers
import { join } from "jsr:@std/path@^1";
import { parseLog } from "./log/parse.ts";
import type { Entry } from "./log/schema.ts";

/**
 * The conversation-session store. A session is just one conversation-log
 * file under `<base>/.pagu/sessions/`; there is no separate metadata — the
 * log is the single source of truth, and a session's title is derived from
 * its first user message at list time. Sessions are per-project (base =
 * the git repo root, else cwd) so conversations live with the work.
 */

export function sessionsDir(base: string): string {
  return join(base, ".pagu", "sessions");
}

/** A filesystem-safe, chronologically-sortable id from a clock. */
export function newSessionId(now: Date): string {
  // 2026-05-27T14-32-05-123Z — lexical order == chronological order.
  return now.toISOString().replace(/[:.]/g, "-");
}

export function sessionPath(base: string, id: string): string {
  return join(sessionsDir(base), `${id}.log.md`);
}

export interface SessionInfo {
  id: string;
  path: string;
  title: string; // first user message (one line), or "(empty)"
  entries: number;
}

/** Derive a one-line, length-capped title from a parsed log. */
function titleOf(log: Entry[]): string {
  const first = log.find((e) => e.kind === "message" && e.role === "user");
  if (first && first.kind === "message") {
    const line = first.text.split("\n")[0].trim();
    return line.length > 60 ? line.slice(0, 57) + "…" : line || "(empty)";
  }
  return "(empty)";
}

/** List stored sessions, newest first (id sorts chronologically). */
export async function listSessions(base: string): Promise<SessionInfo[]> {
  const dir = sessionsDir(base);
  const infos: SessionInfo[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".log.md")) continue;
      const id = e.name.slice(0, -".log.md".length);
      const path = join(dir, e.name);
      try {
        const log = parseLog(await Deno.readTextFile(path));
        infos.push({ id, path, title: titleOf(log), entries: log.length });
      } catch {
        infos.push({ id, path, title: "(unreadable)", entries: 0 });
      }
    }
  } catch {
    return []; // no store yet
  }
  infos.sort((a, b) => b.id.localeCompare(a.id));
  return infos;
}

/** The most-recent session's path, or null if the store is empty. */
export async function latestSession(base: string): Promise<string | null> {
  const all = await listSessions(base);
  return all.length > 0 ? all[0].path : null;
}

/** Load and parse a session log (empty array if the file doesn't exist). */
export async function loadLog(path: string): Promise<Entry[]> {
  try {
    return parseLog(await Deno.readTextFile(path));
  } catch {
    return [];
  }
}
