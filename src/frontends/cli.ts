// effects: terminal frontend (one-shot)
import { loadConfig } from "../config/config.ts";
import {
  buildContext,
  completionsCommand,
  loadCwdEnv,
  parseArgs,
  readLine,
} from "../config/setup.ts";
import { type Approver, resumePending, runTask, type UI } from "../agent.ts";
import { gitRoot } from "../config/repo.ts";
import { listSessions } from "../config/sessions.ts";
import { listProfiles } from "../config/profiles.ts";
import { listPersonalities } from "../config/personalities.ts";

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

// `pagu vm <task>` runs pagu inside an isolated guest (the coarse outer tier).
// Handled before the normal flow; it re-execs pagu in a container (or runs
// directly when no runtime is available).
if (Deno.args[0] === "vm") {
  await (await import("./vm.ts")).vmMain(Deno.args.slice(1));
  Deno.exit(0);
}

// `pagu serve <task>` runs the task, then exposes its pending proposal over HTTP
// for an out-of-band approver (a phone, a LAN device). Re-execs itself with
// inbound net scoped to the bind address — the only frontend that opens a socket.
if (Deno.args[0] === "serve") {
  await (await import("./serve.ts")).serveMain(Deno.args.slice(1));
  Deno.exit(0);
}

// `pagu schedule "<instruction>"` runs one scheduled firing (#16): the cron
// target. The trigger payload (if any) arrives on stdin. The instruction is
// authored; the payload is an untrusted observation (it can't instruct).
if (Deno.args[0] === "schedule") {
  await (await import("./schedule.ts")).scheduleMain(Deno.args.slice(1));
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

// --list-profiles: print available profiles (project shadows global) and exit.
if (opts.listProfiles) {
  const base = (await gitRoot(Deno.cwd())) ?? Deno.cwd();
  const profiles = await listProfiles(base);
  if (profiles.length === 0) console.log("no profiles found.");
  for (const p of profiles) console.log(`${p.name}  (${p.scope})`);
  Deno.exit(0);
}

// --list-personalities: print available personalities and exit.
if (opts.listPersonalities) {
  const base = (await gitRoot(Deno.cwd())) ?? Deno.cwd();
  const personalities = await listPersonalities(base);
  if (personalities.length === 0) console.log("no personalities found.");
  for (const p of personalities) console.log(`${p.name}  (${p.scope})`);
  Deno.exit(0);
}

// --acp: run as an ACP agent over stdio (editor clients drive pagu). stdin/
// stdout become the JSON-RPC channel, so this must precede any TTY/task logic.
if (opts.acp) {
  await (await import("./acp.ts")).acpMain(opts, agents);
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
  return ans?.trim().toLowerCase() === "y" ? "approve" : "reject";
};

await loadCwdEnv(); // terminal frontend: offer to source cwd .env first
// buildContext fails loud on a startup/config error (a misspelled --role /
// --skill / --profile / --personality, a bad provider): surface one clean line,
// not a stack trace.
let ctx;
try {
  ctx = await buildContext(opts, agents, ui, approve);
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  Deno.exit(2);
}
// A session reopened (e.g. --continue) on a pending proposal resolves it first.
await resumePending(ctx);
await runTask(ctx, opts.task);
