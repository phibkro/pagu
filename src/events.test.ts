import { assertEquals } from "@std/assert";
import type { Entry } from "./log/schema.ts";
import { parseLog } from "./log/parse.ts";
import { serializeLog } from "./log/serialize.ts";
import { eventStream } from "./events.ts";

const msg = (text: string): Entry => ({ kind: "message", role: "user", text });

Deno.test("eventStream.since: addressable read returns events from an offset", () => {
  const log: Entry[] = [msg("a"), msg("b"), msg("c")];
  const s = eventStream(log);
  assertEquals(s.offset(), 3);
  assertEquals(s.since(1), [
    { offset: 1, entry: msg("b") },
    { offset: 2, entry: msg("c") },
  ]);
  assertEquals(s.since(3), []);
  assertEquals(s.since(0).length, 3);
});

Deno.test("eventStream.subscribe: yields backlog from offset, then live appends", async () => {
  const log: Entry[] = [msg("a")];
  const s = eventStream(log);
  const seen: Array<{ offset: number; text: string }> = [];

  const consumer = (async () => {
    for await (const { offset, entry } of s.subscribe(0)) {
      if (entry.kind === "message") seen.push({ offset, text: entry.text });
      if (seen.length === 3) break; // got backlog + both live appends
    }
  })();

  // The consumer has drained the backlog and is now awaiting; appends + notify
  // are how the writer (persist) wakes it.
  log.push(msg("b"));
  s.notify();
  log.push(msg("c"));
  s.notify();

  await consumer;
  assertEquals(seen, [
    { offset: 0, text: "a" },
    { offset: 1, text: "b" },
    { offset: 2, text: "c" },
  ]);
});

Deno.test("eventStream.subscribe: a later offset skips the backlog", async () => {
  const log: Entry[] = [msg("a"), msg("b")];
  const s = eventStream(log);
  const seen: string[] = [];
  const consumer = (async () => {
    for await (const { entry } of s.subscribe(2)) {
      if (entry.kind === "message") seen.push(entry.text);
      if (seen.length === 1) break;
    }
  })();
  log.push(msg("c"));
  s.notify();
  await consumer;
  assertEquals(seen, ["c"]); // a, b were before offset 2
});

Deno.test("eventStream.close ends an idle subscription", async () => {
  const s = eventStream([msg("a")]);
  const seen: string[] = [];
  const consumer = (async () => {
    for await (const { entry } of s.subscribe(0)) {
      if (entry.kind === "message") seen.push(entry.text);
    }
  })();
  s.close(); // drains backlog "a", then the await resolves and the loop ends
  await consumer;
  assertEquals(seen, ["a"]);
});

// The event-schema-as-public-API floor (CONTEXT #14): once a non-co-located
// subscriber reads events, the Entry wire contract must not change
// incompatibly. This object requires exactly one entry per kind — remove or
// rename a kind and it stops satisfying the mapped type, so `deno check` fails
// (structural, like the mod.ts surface floor). The round-trip then witnesses
// that each kind survives the codec the wire form rides on.
const WIRE_CONTRACT: { [K in Entry["kind"]]: Extract<Entry, { kind: K }> } = {
  message: { kind: "message", role: "user", text: "" },
  observation: { kind: "observation", source: "", content: "" },
  script: { kind: "script", id: "", lang: "ts", body: "" },
  "skill-invoke": { kind: "skill-invoke", id: "", script: "" },
  "command-invoke": { kind: "command-invoke", id: "", program: "", args: [] },
  perms: { kind: "perms", script: "", perms: [] },
  decision: { kind: "decision", script: "", verdict: "approve", rationale: "" },
  result: { kind: "result", script: "", exit: 0, ranWith: [], output: "" },
  grant: { kind: "grant", id: "", perms: [], expires: "" },
  revoke: { kind: "revoke", grant: "" },
  request: {
    kind: "request",
    id: "",
    need: "",
    justification: "",
    fsRo: "",
  },
  "request-decision": {
    kind: "request-decision",
    request: "",
    verdict: "deny",
    scope: null,
    tier: "operator",
    rationale: "",
  },
  "policy-grant": {
    kind: "policy-grant",
    id: "",
    request: "",
    scope: "session",
    fsRo: "",
  },
};

Deno.test("event wire schema: every entry kind round-trips (public-API floor)", () => {
  const all = Object.values(WIRE_CONTRACT);
  assertEquals(parseLog(serializeLog(all)), all);
});
