import { assertEquals } from "@std/assert";
import { loadEnvInto } from "./envfile.ts";

Deno.test("loadEnvInto: sets vars (export prefix, quotes, comments handled)", () => {
  const set = loadEnvInto(
    [
      "# a comment",
      "",
      "PAGU_TEST_PLAIN=abc",
      "export PAGU_TEST_EXPORTED=def",
      `PAGU_TEST_QUOTED="g h i"`,
    ].join("\n"),
  );
  assertEquals(set.sort(), [
    "PAGU_TEST_EXPORTED",
    "PAGU_TEST_PLAIN",
    "PAGU_TEST_QUOTED",
  ]);
  assertEquals(Deno.env.get("PAGU_TEST_PLAIN"), "abc");
  assertEquals(Deno.env.get("PAGU_TEST_EXPORTED"), "def"); // export stripped
  assertEquals(Deno.env.get("PAGU_TEST_QUOTED"), "g h i"); // quotes stripped
  for (const k of set) Deno.env.delete(k);
});
