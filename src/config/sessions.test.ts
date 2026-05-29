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

interface Model {
  store: Map<string, { meta: SessionMeta; entries: Entry[] }>;
  activeId: string;
}
interface Real {
  base: string;
  activeId: string;
  activeMeta: SessionMeta;
  activeLog: Entry[];
  clock: number;
}

/** Mint a fresh id + created stamp from a monotonic clock (distinct ids). */
function fresh(r: Real): { id: string; created: string } {
  const d = new Date(Date.UTC(2026, 0, 1, 0, 0, r.clock++));
  return { id: newSessionId(d), created: d.toISOString() };
}

/** Persist exactly as buildContext's `persist` does (the contract under test). */
function persist(r: Real): void {
  Deno.mkdirSync(sessionsDir(r.base), { recursive: true });
  Deno.writeTextFileSync(
    sessionPath(r.base, r.activeId),
    serializeFrontmatter(r.activeMeta) + serializeLog(r.activeLog),
  );
}

/** The replayability invariant: a stored session reloads to the model's view. */
async function assertRoundTrips(r: Real, m: Model, id: string): Promise<void> {
  const expected = m.store.get(id)!;
  const loaded = await loadSession(sessionPath(r.base, id));
  assertEquals(loaded.entries, expected.entries);
  assertEquals(loaded.meta.created, expected.meta.created);
  assertEquals(loaded.meta.name, expected.meta.name);
}

class NewSession implements fc.AsyncCommand<Model, Real> {
  check = () => true;
  async run(m: Model, r: Real): Promise<void> {
    const { id, created } = fresh(r);
    r.activeId = id;
    r.activeMeta = { created };
    r.activeLog = [];
    persist(r);
    m.store.set(id, { meta: { created }, entries: [] });
    m.activeId = id;
    await assertRoundTrips(r, m, id);
  }
  toString = () => "new";
}

class Fork implements fc.AsyncCommand<Model, Real> {
  check = () => true;
  async run(m: Model, r: Real): Promise<void> {
    const parentId = r.activeId;
    const { id, created } = fresh(r);
    r.activeLog = [...r.activeLog]; // a fork is a copy, not an alias
    r.activeId = id;
    r.activeMeta = { created };
    persist(r);
    m.store.set(id, {
      meta: { created },
      entries: [...m.store.get(parentId)!.entries],
    });
    m.activeId = id;
    await assertRoundTrips(r, m, id);
    await assertRoundTrips(r, m, parentId); // isolation: parent untouched
  }
  toString = () => "fork";
}

class AppendTurn implements fc.AsyncCommand<Model, Real> {
  constructor(private es: Entry[]) {}
  check = () => true;
  async run(m: Model, r: Real): Promise<void> {
    r.activeLog.push(...this.es);
    persist(r);
    m.store.get(r.activeId)!.entries.push(...this.es);
    await assertRoundTrips(r, m, r.activeId);
  }
  toString = () => `append(${this.es.length})`;
}

class Rename implements fc.AsyncCommand<Model, Real> {
  constructor(private name: string) {}
  check = () => true;
  async run(m: Model, r: Real): Promise<void> {
    const idBefore = r.activeId;
    r.activeMeta = { ...r.activeMeta, name: this.name };
    persist(r);
    const md = m.store.get(r.activeId)!;
    md.meta = { ...md.meta, name: this.name };
    assertEquals(r.activeId, idBefore); // id immutable across rename
    await assertRoundTrips(r, m, r.activeId);
  }
  toString = () => `rename(${JSON.stringify(this.name)})`;
}

class Load implements fc.AsyncCommand<Model, Real> {
  constructor(private i: number) {}
  check = () => true;
  async run(m: Model, r: Real): Promise<void> {
    const ids = [...m.store.keys()];
    const id = ids[this.i % ids.length];
    const loaded = await loadSession(sessionPath(r.base, id));
    r.activeId = id;
    r.activeMeta = loaded.meta;
    r.activeLog = loaded.entries;
    m.activeId = id;
    const expected = m.store.get(id)!;
    assertEquals(loaded.entries, expected.entries);
    assertEquals(loaded.meta.created, expected.meta.created);
    assertEquals(loaded.meta.name, expected.meta.name);
  }
  toString = () => `load(${this.i})`;
}

class List implements fc.AsyncCommand<Model, Real> {
  check = () => true;
  async run(m: Model, r: Real): Promise<void> {
    const infos = await listSessions(r.base);
    assertEquals(
      new Set(infos.map((s) => s.id)),
      new Set([...m.store.keys()]),
    );
    for (const s of infos) {
      assertEquals(s.entries, m.store.get(s.id)!.entries.length);
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
        const base = `${parent}/run${runId++}`;
        const setup = () => {
          // Start with one active, persisted session (mirrors buildContext).
          const r: Real = {
            base,
            activeId: "",
            activeMeta: { created: "" },
            activeLog: [],
            clock: 0,
          };
          const { id, created } = fresh(r);
          r.activeId = id;
          r.activeMeta = { created };
          persist(r);
          const m: Model = {
            store: new Map([[id, { meta: { created }, entries: [] }]]),
            activeId: id,
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
