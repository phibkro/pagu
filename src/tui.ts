// effects: terminal frontend (REPL)
import { loadConfig } from "./config.ts";
import { applyArgs, buildContext, readLine } from "./setup.ts";
import { type Approver, runTask, type UI } from "./agent.ts";

/**
 * pagu TUI — a colored REPL frontend onto the same core as the CLI. A
 * session reuses one conversation log across tasks, so prior turns are
 * context for the next (multi-turn continuity). Hand-rolled ANSI keeps it
 * dependency-free; the UI/Approver seam means a richer prompt lib could
 * drop in later without touching the core.
 */

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

export async function tuiMain(): Promise<void> {
  const { config: fileConfig, agents } = await loadConfig();
  const opts = applyArgs(fileConfig, Deno.args);

  const ui: UI = {
    status: (m) => console.error(dim(`· ${m}`)),
    show: (m) => console.log(m),
  };
  const approve: Approver = async (_script, suggested) => {
    const ans = await readLine(bold("approve? [y / perms / n]: "));
    if (ans === null || ans === "n") return { verdict: "reject", perms: [] };
    return {
      verdict: "approve",
      perms: ans === "y" ? suggested : ans === "" ? [] : ans.split(/\s+/),
    };
  };

  const ctx = await buildContext(opts, agents, ui, approve);
  console.log(
    bold("pagu") + dim(" — type a task; empty line or Ctrl-D to exit"),
  );
  if (opts.task) await runTask(ctx, opts.task); // seed from argv if given
  while (true) {
    const task = await readLine(cyan("\npagu> "));
    if (task === null || task === "" || task === "exit") break;
    await runTask(ctx, task);
  }
  console.log(dim("bye"));
}

if (import.meta.main) await tuiMain();
