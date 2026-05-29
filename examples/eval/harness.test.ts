import { assertEquals } from "@std/assert";
import { aggregate, type ScenarioScore, scorecard } from "./harness.ts";

const score = (over: Partial<ScenarioScore> = {}): ScenarioScore => ({
  success: true,
  cageRounds: 0,
  securityFloorHeld: true,
  attackSucceeded: false,
  ...over,
});

Deno.test("aggregate: successRate is pass^k (fraction of runs that succeeded)", () => {
  const r = aggregate("s", false, [
    score({ success: true }),
    score({ success: false }),
    score({ success: true }),
    score({ success: true }),
  ]);
  assertEquals(r.successRate, 0.75);
});

Deno.test("aggregate: cage-round mean/max + floor/attack folds", () => {
  const r = aggregate("s", true, [
    score({ cageRounds: 1, securityFloorHeld: true, attackSucceeded: false }),
    score({ cageRounds: 3, securityFloorHeld: true, attackSucceeded: true }),
  ]);
  assertEquals(r.meanCageRounds, 2);
  assertEquals(r.maxCageRounds, 3);
  assertEquals(r.floorHeldAll, true);
  assertEquals(r.attackEverSucceeded, true); // any run
});

Deno.test("aggregate: floorHeldAll is false if any run breached", () => {
  const r = aggregate("s", false, [
    score({ securityFloorHeld: true }),
    score({ securityFloorHeld: false }),
  ]);
  assertEquals(r.floorHeldAll, false);
});

Deno.test("scorecard: benign utility / utility-under-attack / attack-success split", () => {
  const benignA = aggregate("a", false, [
    score({ success: true }),
    score({ success: true }),
  ]);
  const benignB = aggregate("b", false, [
    score({ success: true }),
    score({ success: false }),
  ]);
  const adv = aggregate("adv", true, [
    score({ success: true, attackSucceeded: false }),
    score({ success: false, attackSucceeded: false }),
  ]);
  const sc = scorecard("m", 2, [benignA, benignB, adv]);
  assertEquals(sc.benignUtility, 0.75); // mean of 1.0 and 0.5
  assertEquals(sc.utilityUnderAttack, 0.5); // adv successRate
  assertEquals(sc.attackSuccessRate, 0); // no adversarial run let the attack win
  assertEquals(sc.floorHeldAll, true);
});

Deno.test("scorecard: attackSuccessRate counts adversarial runs where the attack won", () => {
  const adv = aggregate("adv", true, [
    score({ attackSucceeded: true }),
    score({ attackSucceeded: false }),
    score({ attackSucceeded: false }),
    score({ attackSucceeded: false }),
  ]);
  assertEquals(scorecard("m", 4, [adv]).attackSuccessRate, 0.25);
});
