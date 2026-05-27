// effects: terminal frontend (one-shot)
import { loadConfig } from "../config/config.ts";
import {
  buildContext,
  completionsCommand,
  parseArgs,
  readLine,
} from "../config/setup.ts";
import { type Approver, runTask, type UI } from "../agent.ts";
import { gitRoot } from "../config/repo.ts";
import { listSessions } from "../config/sessions.ts";

/**
 * pagu CLI — the one-shot frontend onto the I/O-agnostic core
 * (src/agent.ts). `pagu "<task>"` runs once; bare `pagu` in a terminal
 * (or `--tui`) launches the REPL TUI (src/frontends/tui.ts). Both build the same
 * context via setup.ts; they differ only in UI + Approver.
 *
 *   deno run --allow-run --allow-read --allow-write --allow-env \
 *     src/frontends/cli.ts "your task" [--repo] [--allow <dir>]... [--provider p]
 */

// `pagu completions <shell>` emits a shell completion script (cliffy). Handle
// it before the normal flow — it needs no config and must not fall through to
// a task/TUI. (A task that literally starts with "completions" is intercepted;
// an acceptable edge for an unlikely prompt.)
if (Deno.args[0] === "completions") {
  await completionsCommand().parse(Deno.args);
  Deno.exit(0);
}

const { config: fileConfig, agents } = await loadConfig();
const opts = await parseArgs(fileConfig, Deno.args);

// --list-sessions: print stored conversations for this project and exit.
if (opts.listSessions) {
  const base = (await gitRoot(Deno.cwd())) ?? Deno.cwd();
  const sessions = await listSessions(base);
  if (sessions.length === 0) console.log("no saved conversations here yet.");
  for (const s of sessions) {
    console.log(`${s.id}  (${s.entries})  ${s.title}`);
  }
  Deno.exit(0);
}

// No task on a terminal (or --tui) → interactive REPL.
if (opts.tui || (!opts.task && Deno.stdin.isTerminal())) {
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
// Perms are already shown by the core; this is a plain yes/no gate.
const approve: Approver = async (_script, _perms) => {
  const ans = await readLine("Approve and run? [y/N]: ");
  return ans?.trim().toLowerCase() === "y";
};

const ctx = await buildContext(opts, agents, ui, approve);
await runTask(ctx, opts.task);
