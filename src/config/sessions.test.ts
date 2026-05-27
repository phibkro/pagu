import { assertEquals, assertMatch } from "@std/assert";
import { serializeLog } from "../log/serialize.ts";
import {
  latestSession,
  listSessions,
  loadSession,
  newSessionId,
  parseFrontmatter,
  serializeFrontmatter,
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
