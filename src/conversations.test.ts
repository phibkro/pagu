import { assertEquals, assertMatch } from "jsr:@std/assert@^1";
import { serializeLog } from "./log/serialize.ts";
import {
  latestSession,
  listSessions,
  newSessionId,
  sessionPath,
  sessionsDir,
} from "./conversations.ts";

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

Deno.test("listSessions / latestSession tolerate a missing store", async () => {
  const base = await Deno.makeTempDir();
  try {
    assertEquals(await listSessions(base), []);
    assertEquals(await latestSession(base), null);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
