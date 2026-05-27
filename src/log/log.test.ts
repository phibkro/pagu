import { assertEquals } from "@std/assert";
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

Deno.test("non-pagu prose is ignored", () => {
  const md = "# notes\n\nsome prose\n\n" +
    serializeLog([{ kind: "message", role: "assistant", text: "ok" }]);
  assertEquals(parseLog(md), [{
    kind: "message",
    role: "assistant",
    text: "ok",
  }]);
});
