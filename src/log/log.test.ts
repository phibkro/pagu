import { assertEquals } from "@std/assert";
import fc from "fast-check";
import type { Entry } from "./schema.ts";
import { serializeLog } from "./serialize.ts";
import { parseLog } from "./parse.ts";

const sample: Entry[] = [
  { kind: "message", role: "user", text: "Rename files by date." },
  { kind: "observation", source: "fs:./photos", content: "a.jpg\nb.jpg" },
  { kind: "script", id: "s1", lang: "ts", body: 'console.log("hi");' },
  { kind: "perms", script: "s1", perms: ["allow-read=./photos"] },
  {
    kind: "decision",
    script: "s1",
    verdict: "approve",
    rationale: "read-only",
  },
  {
    kind: "result",
    script: "s1",
    exit: 0,
    ranWith: ["--allow-read=./photos"],
    output: "2",
  },
];

Deno.test("log round-trips through serialize -> parse", () => {
  assertEquals(parseLog(serializeLog(sample)), sample);
});

Deno.test("multi-flag ran-with is quoted and split back", () => {
  const e: Entry[] = [{
    kind: "result",
    script: "s1",
    exit: 1,
    ranWith: ["--allow-read=.", "--allow-net=host"],
    output: "",
  }];
  assertEquals(parseLog(serializeLog(e)), e);
});

Deno.test("script body with backticks survives (tilde fences)", () => {
  const e: Entry[] = [{
    kind: "script",
    id: "s2",
    lang: "ts",
    body: "const s = `tpl ${1 + 1}`;\nconsole.log(s);",
  }];
  assertEquals(parseLog(serializeLog(e)), e);
});

Deno.test("command-invoke round-trips", () => {
  const e: Entry[] = [{
    kind: "command-invoke",
    id: "ci1",
    program: "deno",
    args: ["task", "lint"],
  }];
  assertEquals(parseLog(serializeLog(e)), e);
});

Deno.test("skill-invoke round-trips with and without args", () => {
  const withArgs: Entry[] = [{
    kind: "skill-invoke",
    id: "sk1",
    script: "run-tests",
    args: ["--filter", "unit"],
  }];
  assertEquals(parseLog(serializeLog(withArgs)), withArgs);

  const noArgs: Entry[] = [{
    kind: "skill-invoke",
    id: "sk2",
    script: "run-tests",
  }];
  assertEquals(parseLog(serializeLog(noArgs)), noArgs);
});

Deno.test("body containing a ~~~ fence line round-trips", () => {
  const e: Entry[] = [{
    kind: "message",
    role: "user",
    text: "before\n~~~\nafter",
  }];
  assertEquals(parseLog(serializeLog(e)), e);
});

Deno.test("non-pagu prose is ignored", () => {
  const md = "# notes\n\nsome prose\n\n" +
    serializeLog([{ kind: "message", role: "assistant", text: "ok" }]);
  assertEquals(parseLog(md), [{
    kind: "message",
    role: "assistant",
    text: "ok",
  }]);
});

// --- round-trip property over the round-trippable domain ---
//
// `parseLog ∘ serializeLog = id` is the codec's core law (the log is the event
// store — a round-trip bug corrupts the conversation). Bodies may contain `~`
// runs of any length (variable-length fences handle them — see serialize.ts).
// The remaining domain constraints reflect the *structured* fields, whose values
// never carry these chars by construction:
//   - joined list elements (args/perms) contain no `\n` (the split char), and
//     ran-with elements no spaces (its split char) — and are non-empty (a single
//     "" element joins to "" and parses back as []);
//   - attr values (ids, source, program …) contain no `"`/newline (the opening
//     line is single-line; values quote only on whitespace).
const join = (cs: string[], min: number) =>
  fc.array(fc.constantFrom(...cs), { minLength: min, maxLength: 14 }).map((a) =>
    a.join("")
  );
const BODY = 'aB7 \n`"=/.:-é中~'.split(""); // `~` included: fences are variable-length
const ATTR = "aB7 `=/.:-é中".split(""); // no `"`, no newline
const ELEM = 'aB7 `"=/.:-é中'.split(""); // arg/perm element: no newline
const RW = "aB7`=/.:-é中".split(""); // ran-with element: no space either
const bodyG = join(BODY, 0);
const attrG = join(ATTR, 1);
const elemsG = fc.array(join(ELEM, 1), { maxLength: 4 });
const rwG = fc.array(join(RW, 1), { maxLength: 4 });

const entryG: fc.Arbitrary<Entry> = fc.oneof(
  fc.record({
    kind: fc.constant("message" as const),
    role: fc.constantFrom("user" as const, "assistant" as const),
    text: bodyG,
  }),
  fc.record({
    kind: fc.constant("observation" as const),
    source: attrG,
    content: bodyG,
  }),
  fc.record({
    kind: fc.constant("script" as const),
    id: attrG,
    lang: attrG,
    body: bodyG,
  }),
  fc.record({
    kind: fc.constant("command-invoke" as const),
    id: attrG,
    program: attrG,
    args: elemsG,
  }),
  fc.oneof(
    fc.record({
      kind: fc.constant("skill-invoke" as const),
      id: attrG,
      script: attrG,
      args: fc.array(join(ELEM, 1), { minLength: 1, maxLength: 4 }),
    }),
    fc.record({
      kind: fc.constant("skill-invoke" as const),
      id: attrG,
      script: attrG,
    }),
  ),
  fc.record({
    kind: fc.constant("perms" as const),
    script: attrG,
    perms: elemsG,
  }),
  fc.record({
    kind: fc.constant("decision" as const),
    script: attrG,
    verdict: fc.constantFrom(
      "approve" as const,
      "reject" as const,
      "expired" as const,
    ),
    rationale: bodyG,
  }),
  fc.record({
    kind: fc.constant("result" as const),
    script: attrG,
    exit: fc.integer(),
    ranWith: rwG,
    output: bodyG,
  }),
  fc.record({
    kind: fc.constant("grant" as const),
    id: attrG,
    perms: elemsG,
    expires: attrG,
  }),
  fc.record({
    kind: fc.constant("revoke" as const),
    grant: attrG,
  }),
  fc.record({
    kind: fc.constant("request" as const),
    id: attrG,
    need: bodyG,
    justification: bodyG,
    fsRo: attrG,
  }),
  fc.record({
    kind: fc.constant("request-decision" as const),
    request: attrG,
    verdict: fc.constantFrom("approve" as const, "deny" as const),
    scope: fc.option(
      fc.constantFrom("once" as const, "session" as const, "persist" as const),
      { nil: null },
    ),
    tier: fc.constantFrom(
      "refuse" as const,
      "auto" as const,
      "operator" as const,
    ),
    rationale: bodyG,
  }),
  fc.record({
    kind: fc.constant("policy-grant" as const),
    id: attrG,
    request: attrG,
    scope: fc.constantFrom(
      "once" as const,
      "session" as const,
      "persist" as const,
    ),
    fsRo: attrG,
  }),
);

Deno.test("log round-trips for any entry sequence (property)", () => {
  fc.assert(
    fc.property(fc.array(entryG, { maxLength: 6 }), (log) => {
      assertEquals(parseLog(serializeLog(log)), log);
    }),
  );
});
