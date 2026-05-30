import { assertEquals } from "@std/assert";
import { pastDeadline, runTask, scheduledRun } from "./agent.ts";
import { createContext } from "./mod.ts";

// Slice 2 of #16: a Budget {maxTurns?, deadlineMs?} bounds a firing. The pure
// `loop` keeps the turn-count bound (loop.test.ts); the wall-clock deadline is
// checked in the effectful turn (it needs a clock). These assert the budget
// gates the loop WITHOUT a model — a bounded firing does no model work.

Deno.test("pastDeadline: no deadline never fires; fires at or after the deadline", () => {
  assertEquals(pastDeadline(1000, undefined), false);
  assertEquals(pastDeadline(1000, 2000), false); // before
  assertEquals(pastDeadline(2000, 2000), true); // at
  assertEquals(pastDeadline(3000, 2000), true); // after
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
