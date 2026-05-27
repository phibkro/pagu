import { assertEquals } from "@std/assert";
import { type Flow, loop, type Step } from "./loop.ts";

// The loop combinator, tested by law with fake steps (no real I/O). A Step's
// carrier is irrelevant to loop — these use a trivial carrier and count runs.

Deno.test("loop runs an immediately-done step exactly once", async () => {
  let runs = 0;
  const step: Step<null> = () => {
    runs++;
    return Promise.resolve("done");
  };
  const flow = await loop(step, 5)(null);
  assertEquals(runs, 1);
  assertEquals(flow, "done");
});

Deno.test("loop stops at the first done", async () => {
  const flows: Flow[] = ["continue", "continue", "done"];
  let runs = 0;
  const step: Step<null> = () => Promise.resolve(flows[runs++]);
  const flow = await loop(step, 5)(null);
  assertEquals(runs, 3); // ran until the done at index 2, no further
  assertEquals(flow, "done");
});

Deno.test("loop respects maxTurns when the step never says done", async () => {
  let runs = 0;
  const step: Step<null> = () => {
    runs++;
    return Promise.resolve("continue");
  };
  const flow = await loop(step, 3)(null);
  assertEquals(runs, 3); // exactly the bound, then stops
  assertEquals(flow, "done");
});
