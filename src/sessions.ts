// effects: filesystem (session store); pure: path/id/frontmatter helpers
import { join } from "@std/path";
import { parseLog } from "./log/parse.ts";
import { frontmatter } from "./frontmatter.ts";
import type { Entry } from "./log/schema.ts";

/**
 * The conversation-session store. A session is one conversation-log file
 * under `<base>/.pagu/sessions/`, named by an immutable timestamp id. Its
 * log entries are the source of truth; a small YAML **frontmatter** block
 * at the top holds session metadata (an optional display `name`, the
 * `created` time). Renaming just rewrites the frontmatter — the file and
 * its id never move. Sessions are per-project (base = git repo root, else
 * cwd) so conversations live with the work.
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

/** Per-session metadata, stored as YAML frontmatter atop the log file. */
export interface SessionMeta {
  name?: string; // optional display name (set via rename)
  created: string; // ISO timestamp; "" if unknown (legacy logs)
}

/**
 * Read session metadata from a log's YAML frontmatter (via the shared
 * `frontmatter` splitter), returning it plus the body. Tolerates a missing
 * block — older logs have none. `created` is an ISO string; since YAML
 * implicitly types an unquoted ISO date as a Date, coerce one back to its
 * ISO string (so legacy unquoted logs still read). Last-modified isn't
 * stored; it comes from the filesystem mtime, always accurate.
 */
export function parseFrontmatter(
  md: string,
): { meta: SessionMeta; body: string } {
  const { data, body } = frontmatter(md);
  const created = data.created instanceof Date
    ? data.created.toISOString()
    : typeof data.created === "string"
    ? data.created
    : "";
  const meta: SessionMeta = { created };
  if (data.name != null) meta.name = String(data.name);
  return { meta, body };
}

/** Render metadata as a YAML frontmatter block (empty string if nothing to
 * store). Values are quoted so YAML reads them back as strings — an unquoted
 * ISO `created` would be parsed as a Date. */
export function serializeFrontmatter(meta: SessionMeta): string {
  const lines: string[] = [];
  if (meta.name) lines.push(`name: ${JSON.stringify(meta.name)}`);
  if (meta.created) lines.push(`created: ${JSON.stringify(meta.created)}`);
  return lines.length ? `---\n${lines.join("\n")}\n---\n\n` : "";
}

/** Load a session: its metadata + parsed entries (empty if no file). */
export async function loadSession(
  path: string,
): Promise<{ meta: SessionMeta; entries: Entry[] }> {
  try {
    const { meta, body } = parseFrontmatter(await Deno.readTextFile(path));
    return { meta, entries: parseLog(body) };
  } catch {
    return { meta: { created: "" }, entries: [] };
  }
}

export interface SessionInfo {
  id: string;
  path: string;
  name?: string; // explicit name, if set
  title: string; // name ?? first user message ?? "(empty)"
  created: string; // frontmatter created, else the id (which is a timestamp)
  modified: Date | null; // filesystem mtime
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
        const { meta, body } = parseFrontmatter(await Deno.readTextFile(path));
        const entries = parseLog(body);
        infos.push({
          id,
          path,
          name: meta.name,
          title: meta.name || titleOf(entries),
          created: meta.created || id,
          modified: (await Deno.stat(path)).mtime,
          entries: entries.length,
        });
      } catch {
        infos.push({
          id,
          path,
          title: "(unreadable)",
          created: id,
          modified: null,
          entries: 0,
        });
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
