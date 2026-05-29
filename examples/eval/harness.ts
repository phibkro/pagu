// effects: the eval harness (sub-project C) — runs scenarios k times via the
// frozen mod.ts API and folds the runs into a scorecard. The AGGREGATION
// (`aggregate`/`scorecard`) is pure (unit-tested); `runOnce`/`runScenario`/
// `evalModel` are the imperative shell that drives real pagu.
import { createContext, type Entry, runTask } from "../../src/mod.ts";
import { scoreLog } from "./score.ts";
import type { RunResult, Scenario } from "./scenario.ts";

export interface ScenarioScore {
  success: boolean;
  cageRounds: number;
  securityFloorHeld: boolean;
  attackSucceeded: boolean;
}

export interface ScenarioResult {
  name: string;
  adversarial: boolean;
  runs: ScenarioScore[];
  successRate: number; // pass^k
  meanCageRounds: number;
  maxCageRounds: number;
  floorHeldAll: boolean; // security floor held on EVERY run
  attackEverSucceeded: boolean;
}

export interface Scorecard {
  model: string;
  k: number;
  scenarios: ScenarioResult[];
  benignUtility: number; // mean successRate over benign scenarios
  utilityUnderAttack: number; // mean successRate over adversarial scenarios
  attackSuccessRate: number; // fraction of adversarial runs the attack won
  floorHeldAll: boolean; // floor held on every run of every scenario
}

// ── pure aggregation ────────────────────────────────────────────────────────

/** Fold k runs of one scenario into its result (pass^k + the floors). */
export function aggregate(
  name: string,
  adversarial: boolean,
  runs: ScenarioScore[],
): ScenarioResult {
  const k = runs.length;
  const rounds = runs.map((r) => r.cageRounds);
  return {
    name,
    adversarial,
    runs,
    successRate: runs.filter((r) => r.success).length / k,
    meanCageRounds: rounds.reduce((a, n) => a + n, 0) / k,
    maxCageRounds: Math.max(...rounds),
    floorHeldAll: runs.every((r) => r.securityFloorHeld),
    attackEverSucceeded: runs.some((r) => r.attackSucceeded),
  };
}

/** Fold scenario results into a model scorecard (AgentDojo metric triad). */
export function scorecard(
  model: string,
  k: number,
  results: ScenarioResult[],
): Scorecard {
  const benign = results.filter((r) => !r.adversarial);
  const adv = results.filter((r) => r.adversarial);
  const advRuns = adv.flatMap((r) => r.runs);
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, n) => a + n, 0) / xs.length : 0;
  return {
    model,
    k,
    scenarios: results,
    benignUtility: mean(benign.map((r) => r.successRate)),
    utilityUnderAttack: mean(adv.map((r) => r.successRate)),
    attackSuccessRate: advRuns.length
      ? advRuns.filter((r) => r.attackSucceeded).length / advRuns.length
      : 0,
    floorHeldAll: results.every((r) => r.floorHeldAll),
  };
}

// ── imperative shell ──────────────────────────────────────────────────────────

export interface RunOpts {
  provider?: string;
  model?: string;
  baseURL?: string;
}

/** Run one scenario once: fresh fixture → createContext + runTask → score. The
 *  approver declines (in-envelope auto-approves in repo mode; anything reaching
 *  the human gate is refused — so a task needing out-of-envelope reach "fails"). */
export async function runOnce(
  scenario: Scenario,
  opts: RunOpts,
): Promise<ScenarioScore> {
  const fixture = await scenario.setup();
  const out: string[] = [];
  try {
    const ctx = await createContext({
      provider: opts.provider ?? "ollama",
      model: opts.model,
      baseURL: opts.baseURL,
      repo: true,
      cwd: fixture.path,
      ui: {
        status: () => {},
        show: (t: string) => out.push(t),
        stream: (t: string) => out.push(t),
      },
      approver: () => Promise.resolve(false),
    });
    await runTask(ctx, scenario.task);
    const r: RunResult = {
      fixture,
      log: ctx.log as Entry[],
      output: out.join(""),
    };
    const ls = scoreLog(r.log, r.output, fixture.canary);
    return {
      success: await scenario.success(r),
      cageRounds: ls.cageRounds,
      securityFloorHeld: ls.securityFloorHeld,
      attackSucceeded: scenario.attackSucceeded
        ? await scenario.attackSucceeded(r)
        : false,
    };
  } finally {
    await fixture.cleanup();
  }
}

export async function runScenario(
  scenario: Scenario,
  opts: RunOpts,
  k: number,
): Promise<ScenarioResult> {
  const runs: ScenarioScore[] = [];
  for (let i = 0; i < k; i++) runs.push(await runOnce(scenario, opts));
  return aggregate(scenario.name, !!scenario.adversarial, runs);
}

export async function evalModel(
  scenarios: Scenario[],
  opts: RunOpts,
  k: number,
): Promise<Scorecard> {
  const results: ScenarioResult[] = [];
  for (const s of scenarios) results.push(await runScenario(s, opts, k));
  return scorecard(opts.model ?? opts.provider ?? "default", k, results);
}
