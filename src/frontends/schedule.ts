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
import { type Approver, scheduledRun, type UI } from "../agent.ts";

export async function scheduleMain(rawArgs: string[]): Promise<never> {
  const { config: fileConfig, agents } = await loadConfig();
  const opts = await parseArgs(fileConfig, rawArgs);
  if (!opts.task) {
    console.error(
      'usage: pagu schedule "<instruction>" [--repo] [--role r] [flags]\n' +
        "       the trigger payload (if any) is read from stdin — pipe it in:\n" +
        '         curl -s "$ALERT_URL" | pagu schedule "investigate" --repo\n' +
        "       a TTY (no pipe) means no payload — a pure time-trigger.",
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

  await scheduledRun(ctx, { instruction: opts.task, payload });
  Deno.exit(0);
}
