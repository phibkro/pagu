import { assertEquals, assertThrows } from "@std/assert";
import { parseBudgetFlags } from "./schedule.ts";

Deno.test("parseBudgetFlags: no budget flags → empty budget, all args pass through", () => {
  const r = parseBudgetFlags(["investigate the alert", "--repo"]);
  assertEquals(r.budget, {});
  assertEquals(r.rest, ["investigate the alert", "--repo"]);
});

Deno.test("parseBudgetFlags: extracts --max-turns/--deadline (seconds→ms) and strips them", () => {
  const r = parseBudgetFlags([
    "task",
    "--max-turns",
    "3",
    "--deadline",
    "120",
    "--repo",
  ]);
  assertEquals(r.budget.maxTurns, 3);
  assertEquals(r.budget.deadlineMs, 120_000); // seconds → ms
  assertEquals(r.rest, ["task", "--repo"]); // budget flags removed
});

Deno.test("parseBudgetFlags: accepts --flag=value form", () => {
  const r = parseBudgetFlags(["--max-turns=2", "--deadline=0.5", "t"]);
  assertEquals(r.budget.maxTurns, 2);
  assertEquals(r.budget.deadlineMs, 500);
  assertEquals(r.rest, ["t"]);
});

Deno.test("parseBudgetFlags: rejects malformed values (fail loud, not silent unbounded)", () => {
  assertThrows(
    () => parseBudgetFlags(["--max-turns", "0"]),
    Error,
    "--max-turns",
  );
  assertThrows(
    () => parseBudgetFlags(["--max-turns", "x"]),
    Error,
    "--max-turns",
  );
  assertThrows(
    () => parseBudgetFlags(["--deadline", "0"]),
    Error,
    "--deadline",
  );
  assertThrows(
    () => parseBudgetFlags(["--deadline", "-5"]),
    Error,
    "--deadline",
  );
});
