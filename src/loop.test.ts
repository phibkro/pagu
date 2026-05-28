import { assertEquals } from "@std/assert";
import { andThen, type Flow, loop, pipeline, type Step } from "./loop.ts";

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

// --- andThen / pipeline ---

Deno.test("andThen runs b after a continues, returning b's flow", async () => {
  const ran: string[] = [];
  const a: Step<null> = () => {
    ran.push("a");
    return Promise.resolve("continue");
  };
  const b: Step<null> = () => {
    ran.push("b");
    return Promise.resolve("done");
  };
  const flow = await andThen(a, b)(null);
  assertEquals(ran, ["a", "b"]);
  assertEquals(flow, "done");
});

Deno.test("andThen short-circuits: a done means b never runs", async () => {
  const ran: string[] = [];
  const a: Step<null> = () => {
    ran.push("a");
    return Promise.resolve("done");
  };
  const b: Step<null> = () => {
    ran.push("b");
    return Promise.resolve("continue");
  };
  const flow = await andThen(a, b)(null);
  assertEquals(ran, ["a"]); // b skipped
  assertEquals(flow, "done");
});

Deno.test("pipeline runs steps in order, short-circuiting at the first done", async () => {
  const ran: string[] = [];
  const mk = (name: string, flow: Flow): Step<null> => () => {
    ran.push(name);
    return Promise.resolve(flow);
  };
  const flow = await pipeline([
    mk("a", "continue"),
    mk("b", "done"),
    mk("c", "continue"),
  ])(null);
  assertEquals(ran, ["a", "b"]); // c skipped after b halts
  assertEquals(flow, "done");
});
