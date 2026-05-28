import { assertEquals, assertRejects } from "@std/assert";
import { spawnPhase } from "./spawn.ts";

// Tests that don't spawn a process (pre-aborted signal) require no --allow-run.
// Tests that kill a running process require --allow-run (run via deno task test).

Deno.test("spawnPhase: pre-aborted signal throws AbortError without spawning", async () => {
  const controller = new AbortController();
  controller.abort();
  const err = await assertRejects(
    () =>
      spawnPhase({
        entry: "/nonexistent.ts",
        flags: [],
        input: {} as never,
        signal: controller.signal,
      }),
    DOMException,
  );
  assertEquals(err.name, "AbortError");
});
