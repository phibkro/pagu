import { assertEquals, assertMatch } from "@std/assert";
import { respondFlags } from "./agent.ts";

// Invariant #1 (AGENTS.md) as an executable guard: the `respond` phase — the
// only process the model drives — may ONLY read the allowlist and reach the
// model. It must never be granted write / run / env / ffi / sys / blanket
// allow. If a change ever widens it, this test fails before anything ships.

Deno.test("respondFlags grants exactly read + net — the no-exec invariant", () => {
  const flags = respondFlags("127.0.0.1:11434", ["/a", "/b"]);
  // Documents the current shape:
  assertEquals(flags, [
    "--allow-net=127.0.0.1:11434",
    "--allow-read=/a",
    "--allow-read=/b",
  ]);
  // The invariant itself: every flag is a scoped read or net — nothing else.
  for (const f of flags) assertMatch(f, /^--allow-(read|net)=\S+$/);
});

Deno.test("respondFlags never emits write/run/all, even with no read paths", () => {
  // Whatever the inputs, the phase only ever gets read + net (here: net only).
  for (const flags of [respondFlags("h:1", []), respondFlags("h:1", ["/x"])]) {
    for (const f of flags) {
      assertMatch(f, /^--allow-(read|net)=/);
      // belt-and-suspenders: explicitly reject the dangerous grants
      for (const bad of ["write", "run", "all", "env", "ffi", "sys"]) {
        if (f === `--allow-${bad}` || f.startsWith(`--allow-${bad}=`)) {
          throw new Error(
            `respond phase must never grant --allow-${bad}: ${f}`,
          );
        }
      }
    }
  }
});
