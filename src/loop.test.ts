import { assertEquals, assertRejects } from "@std/assert";
import fc from "fast-check";
import {
  andThen,
  fanOut,
  type Flow,
  loop,
  pipeline,
  type Step,
} from "./loop.ts";

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

// --- fanOut: eager-parallel fold of the Flow monoid ---

// A pure branch returning a predetermined flow, bumping an out-of-band counter
// (NOT carrier mutation — preserves the read-only contract). The carrier is
// the counter array index space; branches never touch it.
type Spec = { flow: Flow };
const branchFrom = (spec: Spec, tick: () => void): Step<null> => () => {
  tick();
  return Promise.resolve(spec.flow);
};
const specArb = fc.record({ flow: fc.constantFrom<Flow>("continue", "done") });

Deno.test("fanOut: identity — empty branches returns continue", async () => {
  assertEquals(await fanOut<null>([])(null), "continue");
});

Deno.test("fanOut: result agrees with pipeline (keystone, oracle=pipeline)", () => {
  fc.assert(
    fc.asyncProperty(fc.array(specArb, { maxLength: 8 }), async (specs) => {
      const noop = () => {};
      const fanFlow = await fanOut(specs.map((s) => branchFrom(s, noop)))(null);
      const pipeFlow = await pipeline(specs.map((s) => branchFrom(s, noop)))(
        null,
      );
      return fanFlow === pipeFlow;
    }),
  );
});

Deno.test("fanOut: runs ALL branches; pipeline runs <= N (execution difference)", () => {
  fc.assert(
    fc.asyncProperty(
      fc.array(specArb, { minLength: 1, maxLength: 8 }),
      async (specs) => {
        let fanCount = 0;
        let pipeCount = 0;
        await fanOut(specs.map((s) => branchFrom(s, () => fanCount++)))(null);
        await pipeline(specs.map((s) => branchFrom(s, () => pipeCount++)))(
          null,
        );
        const firstDone = specs.findIndex((s) => s.flow === "done");
        const expectedPipe = firstDone === -1 ? specs.length : firstDone + 1;
        // fanOut runs every branch; pipeline stops at (and including) first done.
        return fanCount === specs.length && pipeCount === expectedPipe &&
          pipeCount <= fanCount;
      },
    ),
  );
});

Deno.test("fanOut: associative — flattening preserves the result", () => {
  fc.assert(
    fc.asyncProperty(
      fc.array(specArb, { maxLength: 5 }),
      fc.array(specArb, { maxLength: 5 }),
      async (xs, ys) => {
        const noop = () => {};
        const flat = await fanOut(
          [...xs, ...ys].map((s) => branchFrom(s, noop)),
        )(null);
        const nested = await fanOut([
          fanOut(xs.map((s) => branchFrom(s, noop))),
          fanOut(ys.map((s) => branchFrom(s, noop))),
        ])(null);
        return flat === nested;
      },
    ),
  );
});

Deno.test("fanOut: commutative — branch order doesn't change the result", () => {
  fc.assert(
    fc.asyncProperty(specArb, specArb, async (a, b) => {
      const noop = () => {};
      const ab = await fanOut([branchFrom(a, noop), branchFrom(b, noop)])(null);
      const ba = await fanOut([branchFrom(b, noop), branchFrom(a, noop)])(null);
      return ab === ba;
    }),
  );
});

Deno.test("fanOut: fail-closed — a throwing branch rejects", async () => {
  const ok: Step<null> = () => Promise.resolve("continue");
  const boom: Step<null> = () => Promise.reject(new Error("boom"));
  await assertRejects(() => fanOut([ok, boom, ok])(null), Error, "boom");
});
