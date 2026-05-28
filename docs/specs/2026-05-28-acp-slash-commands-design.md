# ACP slash commands — design (v1)

> Status: design, pending grill-with-docs. Roadmap: CONTEXT.md → Open → "ACP —
> remaining integration work" (advertise slash commands). Authored via
> brainstorming.

## Goal

Let editors (Zed) offer pagu's config/state commands as slash commands, and
route a chosen command back to the same handler. The enabling work is extracting
the command set out of the TUI's switch into a **frontend-agnostic shape** both
frontends consume — applying the declare-locally / aggregate-centrally pattern
(a `Command` type + a generalised dispatch + the piped-in command list), the
static sibling of the proposal–handler model (`docs/CONCEPTS.md`).

## Scope

- **Config/state commands, shared over ACP:** `/model`, `/provider`, `/roles`,
  `/skills`, `/advisor`, `/help` — change agent config mid-session, report a
  result line. These move out of `tui.ts`'s switch into shared `Command`
  declarations.
- **TUI-only (stay local):** `/sessions`, `/new`, `/open`, `/fork`, `/rename`,
  `/history`, `/log`, `/clear`, `/exit` — session-navigation + arrow-key pickers
  (`select.ts`). **Zed owns session management** via the protocol (new thread =
  `session/new`, reopen = `session/load`), so exposing these over ACP would be
  redundant and conflict with Zed's UI.

## The model

Declare each command once as a value; both frontends + the ACP advertiser read
the piped-in list. No global registry object / framework — just a type + a
dispatch fn.

## Design

### `src/commands.ts` (application layer — shared, not per-frontend)

```ts
export interface Command {
  name: string; // "/model"
  description: string; // for /help and ACP advertisement
  // run reports via ctx.ui.show — the port both frontends implement.
  run: (ctx: AgentContext, args: string) => void | Promise<void>;
}

// Generalised dispatch: match the first token to a command name, call its run with
// the rest of the line as `args`. Returns whether a command handled the line.
export function runCommand(
  cmds: Command[],
  line: string,
  ctx: AgentContext,
): Promise<boolean>;

// The shared config/state commands, declared as values. Each run calls the existing
// ctx.* method (setProvider/setRoles/setSkills/setAdvisor) and ctx.ui.show()s the
// result. `/help` is built from the list itself.
export const configCommands: Command[];
```

Output goes through `ctx.ui.show` instead of `console.log` — in the TUI that's
the console (drops the `dim()` cosmetic, acceptable); in ACP it's an
`agent_message_chunk`.

### TUI (`tui.ts`)

`handleCommand` first tries `runCommand(configCommands, line, ctx)`; if it
returns `false` (not a config command), fall through to the existing
**TUI-only** handlers (nav/pickers, `/exit`). The six config cases leave the
switch.

### ACP (`acp.ts`)

- **Advertise:** after `newSession` and `loadSession`, send a `session/update`
  `available_commands_update` mapping `configCommands` → `{name, description}`.
  (After load so reopened threads still offer them.)
- **Route:** in `prompt()`, if the extracted text starts with `/`, call
  `runCommand(configCommands, text, ctx)` (output flows via `acpUI` →
  `agent_message_chunk`) instead of `runTask`. A non-command line goes to
  `runTask` as today.

### `docs/CONCEPTS.md`

Add a short note naming the **declare-locally / aggregate-centrally** pattern
(commands as the worked example; the static sibling of the proposal–handler
model). Not a generic framework — codify that only at a third instance (rule of
three).

## Testing

- **`runCommand` by example** (pure-ish, fake command list, no real I/O): a
  matching `/foo bar` fires `foo.run(ctx, "bar")` and returns `true`; an unknown
  `/x` returns `false`; a non-`/` line returns `false`.
- **Advertise mapping**: `configCommands` → `AvailableCommand[]` has the right
  names/descriptions.
- **ACP route** (fake `AcpConn`): a `/`-prefixed prompt dispatches to
  `runCommand` (not `runTask`); `newSession`/`loadSession` emit an
  `available_commands_update`.
- **TUI**: a config command delegates to `runCommand`; a TUI-only command still
  works.

## Success criteria

1. `Command` + `runCommand` + `configCommands` in `src/commands.ts`, tested.
2. The six config commands removed from `tui.ts`'s switch and driven via
   `runCommand`; TUI behavior unchanged for the user.
3. ACP advertises the commands (Zed shows them) and routes a chosen one to its
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
