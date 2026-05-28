# ACP slash commands — design (v1)

> Status: hardened via grill-with-docs (2026-05-28); ready for tdd. Grill
> resolved: (A) renamed `Command` → `SlashCommand` (the glossary + code already
> use "command" for the command-policy/`run_task` domain — `CommandEntry`); (B)
> ACP routing is try-`runCommand`-then-fall-through-to-`runTask` (not a
> `/`-prefix check), so a real prompt leading with `/` reaches the model; (C)
> `/help` is frontend-specific, so it leaves the shared set and ACP (Zed's
> `availableCommands` menu is the help). Roadmap: CONTEXT.md → Open → "ACP —
> remaining integration work". Authored via brainstorming.

## Goal

Let editors (Zed) offer pagu's config commands as slash commands, and route a
chosen command back to the same handler. The enabling work is extracting the
command set out of the TUI's switch into a **frontend-agnostic shape** both
frontends consume — applying the declare-locally / aggregate-centrally pattern
(a `SlashCommand` type + a generalised dispatch + the piped-in command list),
the static sibling of the proposal–handler model (`docs/CONCEPTS.md`).

## Scope

- **Config commands, shared over ACP (5):** `/model`, `/provider`, `/roles`,
  `/skills`, `/advisor` — change agent config mid-session, report a result line.
  These move out of `tui.ts`'s switch into shared `SlashCommand` declarations.
- **`/help` is frontend-specific** — it lists the commands available in _this_
  frontend (TUI = config + nav/pickers; ACP = just the five). So it is **not** a
  shared `SlashCommand`: the TUI keeps its own `/help` over its full set, and
  ACP needs none (Zed renders `availableCommands` as its command menu — that
  _is_ help).
- **TUI-only (stay local):** `/sessions`, `/new`, `/open`, `/fork`, `/rename`,
  `/history`, `/log`, `/clear`, `/exit`, `/help` — session-navigation +
  arrow-key pickers (`select.ts`). **Zed owns session management** via the
  protocol, so exposing these over ACP would be redundant and conflict with
  Zed's UI.

## The model

Declare each command once as a value; both frontends + the ACP advertiser read
the piped-in list. No global registry object / framework — just a type + a
dispatch fn.

## Design

### `src/commands.ts` (application layer — shared, not per-frontend)

```ts
export interface SlashCommand {
  name: string; // "/model"
  description: string; // for ACP advertisement (and the TUI's /help)
  // run reports via ctx.ui.show — the port both frontends implement.
  run: (ctx: AgentContext, args: string) => void | Promise<void>;
}

// Generalised dispatch: match the first token to a command name, call its run with
// the rest of the line as `args`. Returns whether a command handled the line.
export function runCommand(
  cmds: SlashCommand[],
  line: string,
  ctx: AgentContext,
): Promise<boolean>;

// The shared config-mutating commands, declared as values. Each run calls the existing
// ctx.* method (setProvider/setRoles/setSkills/setAdvisor) and ctx.ui.show()s the
// result. (/help is NOT here — it's frontend-specific; see Scope.)
export const slashCommands: SlashCommand[];
```

Output goes through `ctx.ui.show` instead of `console.log` — in the TUI that's
the console (drops the `dim()` cosmetic, acceptable); in ACP it's an
`agent_message_chunk`.

### TUI (`tui.ts`)

`handleCommand` first tries `runCommand(slashCommands, line, ctx)`; if it
returns `false`, fall through to the existing **TUI-only** handlers
(nav/pickers, `/help`, `/exit`). The five config cases leave the switch; `/help`
stays (it lists the TUI's full set: the shared `slashCommands` + the TUI-only
ones).

### ACP (`acp.ts`)

- **Advertise:** after `newSession` and `loadSession`, send a `session/update`
  `available_commands_update` mapping `slashCommands` → `{name, description}`.
  (After load so reopened threads still offer them.)
- **Route:** in `prompt()`, **try `runCommand(slashCommands, text, ctx)`
  first**; if it returns `false` (no command name matched), fall through to
  `runTask`. `runCommand` matches only exact known command names, so a real
  prompt that merely begins with `/` (e.g. "what's in `/etc/hosts`?") falls
  through to the model — ACP never emits an "unknown command" error. Command
  output flows via `acpUI` → `agent_message_chunk`.

### `docs/CONCEPTS.md`

Add a short note naming the **declare-locally / aggregate-centrally** pattern
(slash commands as the worked example; the static sibling of the
proposal–handler model). Not a generic framework — codify that only at a third
instance (rule of three).

## Testing

- **`runCommand` by example** (pure-ish, fake command list, no real I/O): a
  matching `/foo bar` fires `foo.run(ctx, "bar")` and returns `true`; an unknown
  `/x` returns `false`; a non-`/` line returns `false`.
- **Advertise mapping**: `slashCommands` → `AvailableCommand[]` has the right
  names/descriptions.
- **ACP route** (fake `AcpConn`): a known-command prompt dispatches to
  `runCommand`; an ordinary prompt (incl. one merely starting with `/`) falls
  through to `runTask`; `newSession`/`loadSession` emit an
  `available_commands_update`.
- **TUI**: a config command delegates to `runCommand`; a TUI-only command (e.g.
  `/help`) still works.

## Success criteria

1. `SlashCommand` + `runCommand` + `slashCommands` in `src/commands.ts`, tested.
2. The five config commands removed from `tui.ts`'s switch and driven via
   `runCommand`; TUI behavior unchanged for the user (incl. `/help`).
3. ACP advertises the five (Zed shows them) and routes a chosen one to its
   handler.
4. Full `deno task ci` green; live check in Zed (slash commands appear + work).

## Deferred

- TUI-only session-nav/picker commands over ACP (Zed owns sessions) — not
  planned.
- A generic registry framework (YAGNI until a third instance).
- Other ACP gaps (cancellation, rich content) — separate slices.

## Invariants preserved

No change to invariant #1. Commands only call existing `ctx.*` config methods
(provider/model/roles/skills/advisor) — no new execute path; they change
settings, not effects. The runner stays the only exec path.
