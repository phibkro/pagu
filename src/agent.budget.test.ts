import { assertEquals } from "@std/assert";
import {
  billedTokens,
  overBudget,
  pastDeadline,
  runTask,
  scheduledRun,
} from "./agent.ts";
import { createContext } from "./mod.ts";

// Slice 2 of #16: a Budget {maxTurns?, deadlineMs?, maxTotalTokens?} bounds a
// firing. The pure `loop` keeps the turn-count bound (loop.test.ts); the
// wall-clock deadline and the token ceiling are checked in the effectful turn
// (they need a clock / the usage tally). These assert the budget gates the loop
// WITHOUT a model — a bounded firing does no model work.

Deno.test("pastDeadline: no deadline never fires; fires at or after the deadline", () => {
  assertEquals(pastDeadline(1000, undefined), false);
  assertEquals(pastDeadline(1000, 2000), false); // before
  assertEquals(pastDeadline(2000, 2000), true); // at
  assertEquals(pastDeadline(3000, 2000), true); // after
});

Deno.test("billedTokens: sums input + output + both cache fields (all billed)", () => {
  assertEquals(billedTokens({ inputTokens: 0, outputTokens: 0 }), 0);
  assertEquals(billedTokens({ inputTokens: 10, outputTokens: 5 }), 15);
  assertEquals(
    billedTokens({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
    }),
    20,
  );
});

Deno.test("overBudget: no cap never fires; fires at or after the token ceiling", () => {
  const u = (n: number) => ({ inputTokens: n, outputTokens: 0 });
  assertEquals(overBudget(u(1_000), undefined), false); // no cap
  assertEquals(overBudget(u(99), 100), false); // under
  assertEquals(overBudget(u(100), 100), true); // at
  assertEquals(overBudget(u(101), 100), true); // over
  // cache tokens count toward the spend (they are billed input)
  assertEquals(
    overBudget({ inputTokens: 50, outputTokens: 40, cacheReadTokens: 10 }, 100),
    true,
  );
});

async function ctxFor(repo: string) {
  return await createContext({
    provider: "ollama",
    baseURL: "http://127.0.0.1:1", // dead — a turn that spawned respond would fail
    repo: true,
    cwd: repo,
    ui: { status() {}, show() {} },
    approver: () => Promise.resolve("reject"),
  });
}

Deno.test("budget maxTurns:0 runs zero turns (loop bounded; respond never spawned)", async () => {
  const repo = await Deno.makeTempDir({ prefix: "pagu-budget-" });
  await new Deno.Command("git", { args: ["init", "-q"], cwd: repo }).output();
  try {
    const ctx = await ctxFor(repo);
    await runTask(ctx, "do something", undefined, { maxTurns: 0 });
    // only the seeded user message — the loop ran 0 turns, so respond (which
    // would have errored on the dead baseURL) was never called.
    assertEquals(ctx.log.length, 1);
    assertEquals(ctx.log[0].kind, "message");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("budget deadlineMs:0 stops the firing before the first turn does work", async () => {
  const repo = await Deno.makeTempDir({ prefix: "pagu-budget-" });
  await new Deno.Command("git", { args: ["init", "-q"], cwd: repo }).output();
  try {
    const ctx = await ctxFor(repo);
    await scheduledRun(ctx, { instruction: "investigate" }, undefined, {
      deadlineMs: 0,
    });
    // seed only (the instruction); the deadline check in the turn fired before
    // respond, so no produced/error entries.
    assertEquals(ctx.log.length, 1);
    assertEquals(ctx.log[0].kind, "message");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("budget maxTotalTokens stops the firing once the token budget is spent", async () => {
  const repo = await Deno.makeTempDir({ prefix: "pagu-budget-" });
  await new Deno.Command("git", { args: ["init", "-q"], cwd: repo }).output();
  try {
    const ctx = await ctxFor(repo);
    // A prior firing's spend already met the ceiling (continuity is the durable
    // log, but usage is per-process — this stands in for "budget already spent").
    ctx.recordUsage({ inputTokens: 100, outputTokens: 50 });
    await runTask(ctx, "do something", undefined, { maxTotalTokens: 100 });
    // The token check in the turn fired before respond (which would have errored
    // on the dead baseURL), so only the seeded user message is present.
    assertEquals(ctx.log.length, 1);
    assertEquals(ctx.log[0].kind, "message");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});
