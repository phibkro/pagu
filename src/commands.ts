// pure-ish: slash-command dispatch shared by the TUI and ACP frontends. A
// command's `run` reports via ctx.ui.show (the port both frontends implement);
// the dispatcher itself does no I/O.
import type { AgentContext } from "./context.ts";
import { PRESETS } from "./config/config.ts";

export interface SlashCommand {
  name: string; // e.g. "/model"
  description: string; // for ACP advertisement and the TUI's /help
  run: (ctx: AgentContext, args: string) => void | Promise<void>;
}

/**
 * Match the first token of `line` to a command name; if found, call its `run`
 * with the rest of the line as `args` and return true. No match → false (the
 * caller treats the line as ordinary input).
 */
export async function runCommand(
  cmds: SlashCommand[],
  line: string,
  ctx: AgentContext,
): Promise<boolean> {
  const name = line.split(/\s+/)[0];
  const cmd = cmds.find((c) => c.name === name);
  if (!cmd) return false;
  const args = line.slice(name.length).trim();
  await cmd.run(ctx, args);
  return true;
}

// The shared config-mutating commands. /help, /roles, /skills are not here
// (frontend-specific / TUI-only picker — see the spec).
const result = (ctx: AgentContext, r: { ok: boolean; message: string }) =>
  ctx.ui.show(`${r.ok ? "→" : "✗"} ${r.message}`);

export const slashCommands: SlashCommand[] = [
  {
    name: "/provider",
    description:
      "Switch provider preset (and optionally model): <name> [model]",
    run: (ctx, args) => {
      const [name, model] = args.split(/\s+/).filter(Boolean);
      if (!name) {
        ctx.ui.show(`providers: ${Object.keys(PRESETS).join(", ")}`);
        ctx.ui.show(`current: ${ctx.provider.model} @ ${ctx.providerHost}`);
        return;
      }
      result(ctx, ctx.setProvider({ provider: name, model }));
    },
  },
  {
    name: "/model",
    description: "Set the model: <name>",
    run: (ctx, args) => {
      if (!args) {
        ctx.ui.show("usage: /model <name>");
        return;
      }
      result(ctx, ctx.setProvider({ model: args }));
    },
  },
  {
    name: "/advisor",
    description: "Advisory reviewer: off | <provider> [model] | (no args = on)",
    run: (ctx, args) => {
      const parts = args.split(/\s+/).filter(Boolean);
      const r = parts[0] === "off"
        ? ctx.setAdvisor({ enabled: false })
        : parts.length === 0
        ? ctx.setAdvisor({})
        : ctx.setAdvisor({ provider: parts[0], model: parts[1] });
      result(ctx, r);
    },
  },
];
