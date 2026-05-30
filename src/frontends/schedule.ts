// effects: the `pagu schedule` frontend (#16) — a one-shot scheduled firing,
// the cron target. Like `cli`, it builds a context and runs once; unlike `cli`
// it uses `scheduledRun` (trigger provenance: the standing instruction is
// authored, the trigger payload is an untrusted observation) and a DEFERRING
// approver — so in-envelope proposals auto-approve (the autonomous tier) and
// out-of-envelope ones queue as pending approvals (the human-in-the-loop tier:
// "the agent diagnosed the 3am failure and proposes this fix; approve when you
// wake"). No inbound net, so no re-exec — the orchestrator stays net-less.
//
//   curl -s … | pagu schedule "investigate the alert and propose a fix" --repo
//   pagu schedule "nightly: review the repo for stale TODOs" --repo </dev/null
import { loadConfig } from "../config/config.ts";
import { buildContext, parseArgs } from "../config/setup.ts";
import { type Approver, type Budget, scheduledRun, type UI } from "../agent.ts";

/** Pull the budget flags out of the raw argv so the rest flows to the standard
 * `parseArgs` (which would reject unknowns). `--max-turns <n>` caps iterations;
 * `--deadline <seconds>` is a wall-clock ceiling for the firing;
 * `--max-total-tokens <n>` caps cumulative billed tokens (distinct from the
 * provider's per-turn output cap, `--max-tokens`). Pure + fail-loud on a
 * malformed value — an unattended cron firing should not silently run unbounded.
 * The testable core of the budget surface. */
export function parseBudgetFlags(
  rawArgs: string[],
): { budget: Budget; rest: string[] } {
  const budget: Budget = {};
  const rest: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    const take = (flag: string): string | null =>
      a === flag
        ? (rawArgs[++i] ?? "")
        : a.startsWith(`${flag}=`)
        ? a.slice(flag.length + 1)
        : null;
    const mt = take("--max-turns");
    if (mt !== null) {
      const n = Number(mt);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(
          `--max-turns must be a positive integer, got ${JSON.stringify(mt)}`,
        );
      }
      budget.maxTurns = n;
      continue;
    }
    const dl = take("--deadline");
    if (dl !== null) {
      const s = Number(dl);
      if (!Number.isFinite(s) || s <= 0) {
        throw new Error(
          `--deadline must be a positive number of seconds, got ${
            JSON.stringify(dl)
          }`,
        );
      }
      budget.deadlineMs = Math.round(s * 1000);
      continue;
    }
    const tok = take("--max-total-tokens");
    if (tok !== null) {
      const n = Number(tok);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(
          `--max-total-tokens must be a positive integer, got ${
            JSON.stringify(tok)
          }`,
        );
      }
      budget.maxTotalTokens = n;
      continue;
    }
    rest.push(a);
  }
  return { budget, rest };
}

export async function scheduleMain(rawArgs: string[]): Promise<never> {
  const { budget, rest } = parseBudgetFlags(rawArgs);
  const { config: fileConfig, agents } = await loadConfig();
  const opts = await parseArgs(fileConfig, rest);
  if (!opts.task) {
    console.error(
      'usage: pagu schedule "<instruction>" [--repo] [--role r]\n' +
        "                     [--max-turns <n>] [--deadline <seconds>]\n" +
        "                     [--max-total-tokens <n>] [flags]\n" +
        "       the trigger payload (if any) is read from stdin — pipe it in:\n" +
        '         curl -s "$ALERT_URL" | pagu schedule "investigate" --repo\n' +
        "       a TTY (no pipe) means no payload — a pure time-trigger.\n" +
        "       --max-turns / --deadline / --max-total-tokens bound an\n" +
        "       unattended firing.",
    );
    Deno.exit(2);
  }

  const ui: UI = {
    status: (m) => console.error(`· ${m}`),
    show: (m) => console.log(m),
  };
  // Defer: the autonomous tier (in-envelope) still auto-approves ahead of this;
  // anything reaching the gate becomes a pending proposal for later human review.
  const approve: Approver = () => Promise.resolve("defer");
  const ctx = await buildContext(opts, agents, ui, approve);

  // The trigger payload arrives on stdin when piped (cron writes the alert/
  // webhook body there); a TTY means a pure time-trigger with no payload.
  const payload = Deno.stdin.isTerminal()
    ? undefined
    : await new Response(Deno.stdin.readable).text();

  await scheduledRun(
    ctx,
    { instruction: opts.task, payload },
    undefined,
    budget,
  );
  Deno.exit(0);
}
