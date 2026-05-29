// effects: owns the live conversation log, its persistence, and the event
// stream. The session state machine — new / fork / load / rename / switch —
// lives here so buildContext, the TUI, and the model-based test all drive the
// SAME code instead of three reimplementations of "mint an id, swap the log,
// persist". The markdown file is the durable projection; `events` is the
// addressable read side, and `persist` is its single notify chokepoint.
import { dirname } from "@std/path";
import type { Entry } from "../log/schema.ts";
import { serializeLog } from "../log/serialize.ts";
import { type EventStream, eventStream } from "../events.ts";
import {
  loadSession,
  newSessionId,
  serializeFrontmatter,
  type SessionMeta,
  sessionPath,
} from "./sessions.ts";

export interface SessionStore {
  /** The live conversation — append in place, then `persist`. */
  readonly log: Entry[];
  /** The addressable/streamable read side of the log; woken by `persist`. */
  readonly events: EventStream;
  /** Path of the active session's log file. */
  currentPath(): string;
  /** Write the active session (frontmatter + log) and wake subscribers. */
  persist(): void;
  /** Rename the active session — rewrites frontmatter; the id never moves. */
  rename(name: string): void;
  /** Repoint to another session, replacing the live log in place. */
  switchTo(path: string, entries: Entry[], meta: SessionMeta): void;
  /** Start a fresh empty session (materialized lazily on first write). */
  newSession(now: Date): void;
  /** Branch the active conversation into a fresh session, materialized now. */
  fork(now: Date): void;
  /** Open a stored session, replacing the live log. */
  load(path: string): Promise<void>;
}

export function makeSessionStore(
  base: string,
  initial: { path: string; meta: SessionMeta; entries: Entry[] },
): SessionStore {
  // The array identity is stable across switches (mutated in place) so the
  // event stream stays bound to it; the {path, meta} box tracks the active one.
  const log: Entry[] = initial.entries;
  const active = { path: initial.path, meta: initial.meta };
  const events = eventStream(log);

  const persist = (): void => {
    Deno.mkdirSync(dirname(active.path), { recursive: true });
    Deno.writeTextFileSync(
      active.path,
      serializeFrontmatter(active.meta) + serializeLog(log),
    );
    events.notify();
  };
  const switchTo = (
    path: string,
    entries: Entry[],
    meta: SessionMeta,
  ): void => {
    active.path = path;
    active.meta = meta;
    log.length = 0;
    log.push(...entries);
  };

  return {
    log,
    events,
    currentPath: () => active.path,
    persist,
    rename: (name) => {
      active.meta = { ...active.meta, name };
      persist();
    },
    switchTo,
    // new (and /clear) do not persist — the file materializes on first write,
    // matching the prior inline behavior.
    newSession: (now) =>
      switchTo(sessionPath(base, newSessionId(now)), [], {
        created: now.toISOString(),
      }),
    // fork persists immediately so the branch shows up in the session list.
    fork: (now) => {
      const entries = [...log];
      switchTo(sessionPath(base, newSessionId(now)), entries, {
        created: now.toISOString(),
      });
      persist();
    },
    load: async (path) => {
      const { meta, entries } = await loadSession(path);
      switchTo(path, entries, meta);
    },
  };
}
