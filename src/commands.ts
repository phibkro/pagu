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

// The shared config-mutating commands. /help is frontend-specific. /roles and
// /skills appear here as the **text form** (list + apply-by-name) that works
// over any frontend; the TUI additionally offers an interactive picker, which
// it handles itself before delegating here.
const result = (ctx: AgentContext, r: { ok: boolean; message: string }) =>
  ctx.ui.show(`${r.ok ? "→" : "✗"} ${r.message}`);

/** Render `* name (scope)` lines (active marked) as one message — ACP
 * concatenates show() chunks with no separator, so newlines go inline. */
function listOrApply(
  ctx: AgentContext,
  args: string,
  noun: "roles" | "skills",
  available: () => Promise<{ name: string; scope: string }[]>,
  activeNames: () => string[],
  set: (names: string[]) => Promise<{ ok: boolean; message: string }>,
): Promise<void> {
  const names = args.split(/\s+/).filter(Boolean);
  if (names.length > 0) return set(names).then((r) => result(ctx, r));
  return available().then((list) => {
    if (list.length === 0) {
      ctx.ui.show(`no ${noun} found (add under .pagu/${noun}/)`);
      return;
    }
    const active = new Set(activeNames());
    const lines = list
      .map((x) => `  ${active.has(x.name) ? "*" : " "} ${x.name} (${x.scope})`)
      .join("\n");
    ctx.ui.show(`${noun}:\n${lines}\n  apply a group: /${noun} <name> [name…]`);
  });
}

export const slashCommands: SlashCommand[] = [
  {
    name: "/provider",
    description:
      "Switch provider preset (and optionally model): <name> [model]",
    run: (ctx, args) => {
      const [name, model] = args.split(/\s+/).filter(Boolean);
      if (!name) {
        // One show with an embedded newline: in ACP each show() is a separate
        // message chunk and chunks concatenate with no separator.
        ctx.ui.show(
          `providers: ${Object.keys(PRESETS).join(", ")}\n` +
            `current: ${ctx.provider.model} @ ${ctx.providerHost}`,
        );
        return;
      }
      result(ctx, ctx.setProvider({ provider: name, model }));
    },
  },
  {
    name: "/model",
    description:
      "Set the model: <name>  (no args lists provider models; `refresh` re-fetches)",
    run: async (ctx, args) => {
      const arg = args.trim();
      if (arg && arg !== "refresh") {
        result(ctx, ctx.setProvider({ model: arg }));
        return;
      }
      try {
        // Lazy cache: show it if populated, else fetch once. `refresh` forces.
        const models = arg === "refresh" || ctx.models().length === 0
          ? await ctx.fetchModels()
          : ctx.models();
        ctx.ui.show(
          models.length === 0
            ? "no models reported by the provider"
            : `models (current: ${ctx.provider.model}):\n` +
              models.map((m) =>
                `  ${m === ctx.provider.model ? "*" : " "} ${m}`
              )
                .join("\n"),
        );
      } catch (e) {
        ctx.ui.show(
          `✗ could not fetch models: ${e instanceof Error ? e.message : e}`,
        );
      }
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
  {
    name: "/roles",
    description: "List roles, or apply a group: <name> [name…]",
    run: (ctx, args) =>
      listOrApply(
        ctx,
        args,
        "roles",
        () => ctx.availableRoles(),
        () => ctx.roleNames(),
        (names) => ctx.setRoles(names),
      ),
  },
  {
    name: "/skills",
    description: "List skills, or apply a group: <name> [name…]",
    run: (ctx, args) =>
      listOrApply(
        ctx,
        args,
        "skills",
        () => ctx.availableSkills(),
        () => ctx.activeSkillScripts.map((s) => s.name),
        (names) => ctx.setSkills(names),
      ),
  },
];
