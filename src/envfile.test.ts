import { assertEquals } from "jsr:@std/assert@^1";
import { loadEnvInto } from "./envfile.ts";

Deno.test("loadEnvInto: parses KEY=value, export prefix, quotes, comments", () => {
  const set = loadEnvInto(
    [
      "# a comment",
      "",
      "PAGU_TEST_PLAIN=abc",
      "export PAGU_TEST_EXPORTED=def",
      `PAGU_TEST_QUOTED="g h i"`,
      "PAGU_TEST_SQUOTED='jkl'",
      "NOT_A_PAIR",
    ].join("\n"),
  );
  assertEquals(set.sort(), [
    "PAGU_TEST_EXPORTED",
    "PAGU_TEST_PLAIN",
    "PAGU_TEST_QUOTED",
    "PAGU_TEST_SQUOTED",
  ]);
  assertEquals(Deno.env.get("PAGU_TEST_PLAIN"), "abc");
  assertEquals(Deno.env.get("PAGU_TEST_EXPORTED"), "def"); // export stripped
  assertEquals(Deno.env.get("PAGU_TEST_QUOTED"), "g h i"); // quotes stripped
  assertEquals(Deno.env.get("PAGU_TEST_SQUOTED"), "jkl");
  for (const k of set) Deno.env.delete(k);
});
