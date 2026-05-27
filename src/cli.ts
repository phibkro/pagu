import { loadConfig } from "./config.ts";
import { applyArgs, buildContext, readLine } from "./setup.ts";
import { type Approver, runTask, type UI } from "./agent.ts";

/**
 * pagu CLI — the one-shot frontend onto the I/O-agnostic core
 * (src/agent.ts). `pagu "<task>"` runs once; bare `pagu` in a terminal
 * (or `--tui`) launches the REPL TUI (src/tui.ts). Both build the same
 * context via setup.ts; they differ only in UI + Approver.
 *
 *   deno run --allow-run --allow-read --allow-write --allow-env \
 *     src/cli.ts "your task" [--repo] [--allow <dir>]... [--provider p]
 */

const { config: fileConfig, agents } = await loadConfig();
const opts = applyArgs(fileConfig, Deno.args);

// No task on a terminal (or --tui) → interactive REPL.
if (Deno.args.includes("--tui") || (!opts.task && Deno.stdin.isTerminal())) {
  await (await import("./tui.ts")).tuiMain();
  Deno.exit(0);
}
if (!opts.task) {
  console.error(
    'usage: pagu "<task>" [--repo] [--allow <dir>]... [--provider p] [--model m]\n' +
      "       (bare `pagu` in a terminal starts the TUI)",
  );
  Deno.exit(2);
}

const ui: UI = {
  status: (m) => console.error(`· ${m}`),
  show: (m) => console.log(m),
};
const approve: Approver = async (_script, suggested) => {
  const ans = await readLine(
    "Approve? 'y' to grant the suggested perms, or type perms " +
      "(e.g. 'allow-read=. allow-write=./out'), blank for none, 'n' to reject: ",
  );
  if (ans === null || ans === "n") return { verdict: "reject", perms: [] };
  return {
    verdict: "approve",
    perms: ans === "y" ? suggested : ans === "" ? [] : ans.split(/\s+/),
  };
};

const ctx = await buildContext(opts, agents, ui, approve);
await runTask(ctx, opts.task);
