import { assertEquals, assertMatch } from "@std/assert";
import fc from "fast-check";
import type { Entry } from "../log/schema.ts";
import { serializeLog } from "../log/serialize.ts";
import {
  latestSession,
  listSessions,
  loadSession,
  newSessionId,
  parseFrontmatter,
  serializeFrontmatter,
  type SessionMeta,
  sessionPath,
  sessionsDir,
} from "./sessions.ts";
import { makeSessionStore, type SessionStore } from "./session-store.ts";

Deno.test("sessionsDir / sessionPath compose under .pagu/sessions", () => {
  assertEquals(sessionsDir("/proj"), "/proj/.pagu/sessions");
  assertEquals(sessionPath("/proj", "abc"), "/proj/.pagu/sessions/abc.log.md");
});

Deno.test("newSessionId is filesystem-safe and sorts chronologically", () => {
  const a = newSessionId(new Date("2026-05-27T14:32:05.123Z"));
  const b = newSessionId(new Date("2026-05-27T14:32:06.000Z"));
  assertMatch(a, /^[\w-]+$/); // no ':' or '.' that would trip the filesystem
  assertEquals(a < b, true); // lexical order == chronological order
});

Deno.test("listSessions: titles from first user message, newest first", async () => {
  const base = await Deno.makeTempDir();
  try {
    // Write two sessions; the lexically-greater id is newer.
    const write = (id: string, firstUser: string) =>
      Deno.writeTextFile(
        sessionPath(base, id),
        serializeLog([
          { kind: "message", role: "user", text: firstUser },
          { kind: "message", role: "assistant", text: "ok" },
        ]),
      );
    await Deno.mkdir(sessionsDir(base), { recursive: true });
    await write("2026-05-27T10-00-00-000Z", "first conversation\nmore");
    await write("2026-05-27T12-00-00-000Z", "second conversation");

    const all = await listSessions(base);
    assertEquals(all.map((s) => s.title), [
      "second conversation", // newest first
      "first conversation", // only the first line of the first user message
    ]);
    assertEquals(all[0].entries, 2);

    const latest = await latestSession(base);
    assertEquals(latest, sessionPath(base, "2026-05-27T12-00-00-000Z"));
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("frontmatter round-trips; name + created parse back", () => {
  const fm = serializeFrontmatter({
    name: "refactor pass",
    created: "2026-05-27T00:00:00.000Z",
  });
  const body = serializeLog([{ kind: "message", role: "user", text: "hi" }]);
  const { meta, body: parsedBody } = parseFrontmatter(fm + body);
  assertEquals(meta.name, "refactor pass");
  assertEquals(meta.created, "2026-05-27T00:00:00.000Z");
  // The body after the frontmatter still parses as a normal log.
  assertEquals(parsedBody.includes("~~~pagu:message"), true);
});

Deno.test("parseFrontmatter reads legacy unquoted ISO created (Date-coerced)", () => {
  // Files written before quoting have `created: <iso>` unquoted → YAML types
  // it as a Date; we coerce back to the ISO string so old logs still read.
  const md = "---\nname: old\ncreated: 2026-05-27T03:08:53.346Z\n---\n\n" +
    serializeLog([{ kind: "message", role: "user", text: "hi" }]);
  const { meta } = parseFrontmatter(md);
  assertEquals(meta.name, "old");
  assertEquals(meta.created, "2026-05-27T03:08:53.346Z");
});

Deno.test("parseFrontmatter tolerates a log with no frontmatter", () => {
  const body = serializeLog([{ kind: "message", role: "user", text: "hi" }]);
  const { meta, body: out } = parseFrontmatter(body);
  assertEquals(meta, { created: "" });
  assertEquals(out, body); // unchanged
});

Deno.test("a named session lists by its name, not the first message", async () => {
  const base = await Deno.makeTempDir();
  try {
    await Deno.mkdir(sessionsDir(base), { recursive: true });
    const id = "2026-05-27T09-00-00-000Z";
    await Deno.writeTextFile(
      sessionPath(base, id),
      serializeFrontmatter({ name: "my project", created: "2026-05-27" }) +
        serializeLog([{ kind: "message", role: "user", text: "do a thing" }]),
    );
    const [s] = await listSessions(base);
    assertEquals(s.name, "my project");
    assertEquals(s.title, "my project"); // name wins over first message

    const loaded = await loadSession(sessionPath(base, id));
    assertEquals(loaded.meta.name, "my project");
    assertEquals(loaded.entries.length, 1);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("listSessions / latestSession tolerate a missing store", async () => {
  const base = await Deno.makeTempDir();
  try {
    assertEquals(await listSessions(base), []);
    assertEquals(await latestSession(base), null);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

// ── Model-based stateful property: the session store under op sequences ──────
//
// CONTEXT backlog #7 / INVARIANTS "the log is always replayable". An fc.commands
// harness generates random sequences of {new, fork, append-turn, rename, load,
// list} against the REAL store (a temp dir), checked against an in-memory model.
// After every step it asserts: the active session round-trips through
// persist→loadSession, a fork leaves its parent untouched (isolation), rename
// keeps the id, and listSessions agrees with the model. This is the store
// serialization contract under sequences — where the fence-collision class of
// bug hides — not the (heavy, effectful) full runTask.

// A realistic turn's entries: arbitrary free-text bodies (the variable-length
// tilde fence handles any string — see the log round-trip law in log.test.ts),
// with structural fields kept to safe tokens and ran-with non-empty (an empty
// join is a codec edge orthogonal to store integrity).
const body = fc.string();
const turnEntry: fc.Arbitrary<Entry> = fc.oneof(
  fc.tuple(fc.constantFrom("user", "assistant"), body).map(
    ([role, text]) => ({ kind: "message", role, text }) as Entry,
  ),
  fc.tuple(fc.constantFrom("read a.ts", "ls dir", "read evil.md"), body).map(
    ([source, content]) => ({ kind: "observation", source, content }) as Entry,
  ),
  fc.tuple(fc.constantFrom("s1", "s2"), body).map(
    ([id, b]) => ({ kind: "script", id, lang: "ts", body: b }) as Entry,
  ),
  fc.tuple(fc.constantFrom("s1", "s2"), fc.integer({ min: 0, max: 255 }), body)
    .map(([script, exit, output]) =>
      ({
        kind: "result",
        script,
        exit,
        ranWith: ["--allow-read=."],
        output,
      }) as Entry
    ),
);

interface Sess {
  meta: SessionMeta;
  entries: Entry[];
}
interface Model {
  /** What should be durably on disk — materialized sessions only. */
  files: Map<string, Sess>;
  /** The live (in-memory) active session — may not be materialized yet. */
  activePath: string;
  active: Sess;
}
interface Real {
  store: SessionStore;
  base: string;
  clock: number;
}

const clone = (s: Sess): Sess => ({
  meta: { ...s.meta },
  entries: [...s.entries],
});

/** Distinct, monotonic clock so minted session ids never collide. */
const freshDate = (r: Real): Date =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, r.clock++));

/** In memory: the store's live log mirrors the model's active session. */
function assertLiveMirror(r: Real, m: Model): void {
  assertEquals(r.store.log, m.active.entries);
  assertEquals(r.store.currentPath(), m.activePath);
}

/** Replayability: a materialized session reloads to the model's view. */
async function assertPersisted(m: Model, path: string): Promise<void> {
  const expected = m.files.get(path)!;
  const loaded = await loadSession(path);
  assertEquals(loaded.entries, expected.entries);
  assertEquals(loaded.meta.created, expected.meta.created);
  assertEquals(loaded.meta.name, expected.meta.name);
}

class NewSession implements fc.AsyncCommand<Model, Real> {
  check = () => true;
  run(m: Model, r: Real): Promise<void> {
    const d = freshDate(r);
    r.store.newSession(d);
    // `new` does NOT persist — the file materializes on the first write.
    m.activePath = r.store.currentPath();
    m.active = { meta: { created: d.toISOString() }, entries: [] };
    assertEquals(r.store.currentPath(), sessionPath(r.base, newSessionId(d)));
    assertLiveMirror(r, m);
    return Promise.resolve();
  }
  toString = () => "new";
}

class AppendTurn implements fc.AsyncCommand<Model, Real> {
  constructor(private es: Entry[]) {}
  check = () => true;
  async run(m: Model, r: Real): Promise<void> {
    r.store.log.push(...this.es); // the orchestrator's ctx.log.push
    r.store.persist();
    m.active.entries.push(...this.es);
    m.files.set(m.activePath, clone(m.active)); // persist materializes it
    assertLiveMirror(r, m);
    await assertPersisted(m, m.activePath);
  }
  toString = () => `append(${this.es.length})`;
}

class Fork implements fc.AsyncCommand<Model, Real> {
  check = () => true;
  async run(m: Model, r: Real): Promise<void> {
    const parent = m.activePath;
    const d = freshDate(r);
    const carried = [...m.active.entries];
    r.store.fork(d); // copies the live log + persists the new session
    m.activePath = r.store.currentPath();
    m.active = { meta: { created: d.toISOString() }, entries: carried };
    m.files.set(m.activePath, clone(m.active));
    assertLiveMirror(r, m);
    await assertPersisted(m, m.activePath);
    if (m.files.has(parent)) await assertPersisted(m, parent); // isolation
  }
  toString = () => "fork";
}

class Rename implements fc.AsyncCommand<Model, Real> {
  constructor(private name: string) {}
  check = () => true;
  async run(m: Model, r: Real): Promise<void> {
    const before = r.store.currentPath();
    r.store.rename(this.name); // rewrites frontmatter + persists
    m.active.meta = { ...m.active.meta, name: this.name };
    m.files.set(m.activePath, clone(m.active));
    assertEquals(r.store.currentPath(), before); // id immutable across rename
    await assertPersisted(m, m.activePath);
  }
  toString = () => `rename(${JSON.stringify(this.name)})`;
}

class Load implements fc.AsyncCommand<Model, Real> {
  constructor(private i: number) {}
  check = (m: Readonly<Model>) => m.files.size > 0;
  async run(m: Model, r: Real): Promise<void> {
    const paths = [...m.files.keys()];
    const path = paths[this.i % paths.length];
    await r.store.load(path);
    m.activePath = path;
    m.active = clone(m.files.get(path)!);
    assertLiveMirror(r, m);
  }
  toString = () => `load(${this.i})`;
}

class List implements fc.AsyncCommand<Model, Real> {
  check = () => true;
  async run(m: Model, r: Real): Promise<void> {
    const infos = await listSessions(r.base);
    assertEquals(
      new Set(infos.map((s) => s.path)),
      new Set([...m.files.keys()]),
    );
    for (const s of infos) {
      assertEquals(s.entries, m.files.get(s.path)!.entries.length);
    }
  }
  toString = () => "list";
}

Deno.test("session store: op sequences preserve replayability + isolation", async () => {
  const parent = await Deno.makeTempDir({ prefix: "pagu-sess-mbt-" });
  let runId = 0;
  const commandArbs: fc.Arbitrary<fc.AsyncCommand<Model, Real>>[] = [
    fc.constant(new NewSession()),
    fc.constant(new Fork()),
    fc.array(turnEntry, { minLength: 1, maxLength: 3 }).map((es) =>
      new AppendTurn(es)
    ),
    fc.string({ minLength: 1 }).map((n) => new Rename(n)),
    fc.nat().map((i) => new Load(i)),
    fc.constant(new List()),
  ];
  const commands = fc.commands(commandArbs, { maxCommands: 24 });

  try {
    await fc.assert(
      fc.asyncProperty(commands, async (cmds) => {
        const setup = () => {
          const base = `${parent}/run${runId++}`;
          // Mirrors buildContext: an initial active session, unmaterialized
          // (no file on disk until the first persist).
          const d0 = new Date(Date.UTC(2026, 0, 1));
          const created = d0.toISOString();
          const path0 = sessionPath(base, newSessionId(d0));
          const store = makeSessionStore(base, {
            path: path0,
            meta: { created },
            entries: [],
          });
          const r: Real = { store, base, clock: 1 };
          const m: Model = {
            files: new Map(),
            activePath: path0,
            active: { meta: { created }, entries: [] },
          };
          return { model: m, real: r };
        };
        await fc.asyncModelRun(setup, cmds);
      }),
      { numRuns: 100 },
    );
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
