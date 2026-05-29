# Stable programmatic API — freeze the public surface (design)

> Status: **hardened 2026-05-29** (brainstorm → grill → tdd-ready). The "stable
> programmatic API" v1-gate item from `CONTEXT.md`. Freezes a small, deliberate
> public surface so external consumers can build their own frontends / loops
> without reaching into internals.

## Goal & intent

Let an **external** consumer drive pagu programmatically — build a custom
frontend (own `UI`/`Approver`), compose their own loops, and inject handlers —
through **one documented front door**, with a **backwards-compatibility
commitment**: once frozen, no backwards-incompatible change for ≥1 year (the API
stays on v1 semver; additions are fine, removals/renames are not).

"Freeze" here is that compat commitment made enforceable — **not** a version
bump. The mechanism (a barrel + a drift test) lands now so the surface is
protected from accidental breakage immediately; the `1.0.0` version + JSR
publish wait for the product v1 milestone.

## Current reality (what this changes)

- **No public barrel, no package metadata.** No `src/mod.ts`; `deno.json` has no
  `name`/`version`/`exports` — pagu is wired as a CLI app, not a library.
- **The de-facto API is whatever the frontends import.** `cli.ts`/`tui.ts`/
  `acp.ts` reach across **eight** internal modules (`agent.ts`, `loop.ts`,
  `config/config.ts`, `config/setup.ts`, `config/sessions.ts`, `config/repo.ts`,
  `config/roles.ts`/`skills/skill.ts`, `commands.ts`) plus `log` + the
  `Capability`/`HandlerPlugin` types. There is no single front door.

## Decisions (resolved in brainstorming)

1. **Target = both, shaped now (C).** Build the barrel + boundary enforcement
   now (serves the in-repo frontends and the design work); _shape_ `deno.json`
   so a JSR publish is a later config flip, not a redesign. Don't add publish
   machinery / semver tags yet.
2. **Scope = drive + compose-loops + inject-handlers (closed capability set).**
   Public: drive the loop, compose loops, inject handler plugins.
   `Capability<Data>` is exposed as a **type only** — the capability _set_ stays
   closed (a new agent tool is an in-repo change under the capability-ladder
   review, never a third-party affordance). Keeps the blast radius statically
   enumerable (invariant #1). _Extendable capabilities are a deferred future
   goal_ — see Deferred.
3. **Surface = narrow & deliberate (A).** Freeze the _minimum_ essentials + one
   high-level constructor; the config/session/command machinery stays internal
   and free to evolve (not part of the compat promise).
4. **Freeze mechanism = barrel + export-set floor test (B).** Not a CI
   single-door rule (C deferred — in-repo frontends already import sensibly).
5. **Version = pre-1.0 now (A).** `version: "0.1.0"`; the floor test protects
   the surface from drift starting now; bump to `1.0.0` + publish at the product
   v1 milestone, when the honest 1-year compat clock starts.

## The public surface (`src/mod.ts`)

`src/mod.ts` is the **only** public entry — a pure barrel (re-exports only). The
frozen surface, grouped:

- **Core loop & ports:** `runTask`; types `AgentContext`, `UI`, `Approver`.
  (`Responder` stays internal — it's plumbing passed _into_ capability execute
  fns for fix-rounds, never supplied by a frontend.)
- **Loop combinators** (pure, lawful): `loop`, `andThen`, `pipeline`, `fanOut`;
  types `Step`, `Flow`.
- **Construction:** `createContext(opts)` — the high-level programmatic
  constructor (see below).
- **Extension point:** type `HandlerPlugin` (consumers implement; passed via
  `createContext({ handlers })`).
- **Reference types:** `Capability<Data>` (set stays closed), `Entry`,
  `ScriptEntry`.

**Deliberately excluded** (stay internal, free to evolve, _not_ frozen):
`loadConfig`/`PRESETS`, `parseArgs`/`buildContext`/`RunOpts`/`readLine`, and the
`sessions`/`roles`/`skills`/`commands`/`repo` helpers.

**In-repo frontends don't change.** `cli.ts`/`tui.ts`/`acp.ts` ship and version
_with_ pagu, so they keep importing internals directly — the freeze is a promise
to _external_ consumers, and `mod.ts` is an additional door, not a forced
re-routing. Low-churn: we _add_ `mod.ts` + `createContext`; we don't refactor
the frontends.

### `createContext` — the programmatic front door

A new function in `config/setup.ts` (co-located with `buildContext`, tested
there), re-exported by `mod.ts`. It gives external consumers a construction path
that does **not** touch cliffy / argv / `RunOpts`.

**`createContext` is hermetic** (decided in grill). It does **not** read ambient
state — no `loadConfig` (global `~/.config/pagu/config.json`), no ambient
AGENTS.md, no `maybeLoadEnvFile` (cwd `.env` + its terminal consent prompt). An
embedded consumer controls everything explicitly: config via `opts`, agent
instructions via `opts.agents` (default `""`), env via their own process. This
keeps a library embed predictable — no surprise reads of the end-user's machine,
no blocking prompt. (Ambient/CLI-style loading is a deferred opt-in — see
Deferred.)

**Required refactor:** `buildContext` currently calls `maybeLoadEnvFile`
internally (ambient + interactive). Lift that **out** of `buildContext` into the
CLI/TUI shell (`cli.ts`/`tui.ts` call it _before_ `buildContext`, so provider
API keys are still visible during their construction). `buildContext` becomes
env-agnostic, and both the CLI path and `createContext` share it. Clean
hexagonal split: ambient/interactive loading is shell, context construction is
core.

```typescript
// illustrative — TDD writes the real signature
export function createContext(opts: {
  // structured config (the PaguConfig/ConfigLayer fields), not argv
  provider?: string;
  model?: string;
  baseURL?: string;
  allow?: string[];
  write?: string[];
  repo?: boolean;
  roles?: string[];
  hide?: string[];
  reveal?: string[];
  hideSecrets?: boolean;
  hideGitignored?: boolean;
  handlers?: HandlerPlugin[];
  /** Agent instructions (the AGENTS.md text) — explicit, not ambient. */
  agents?: string;
  // the I/O seam
  ui: UI;
  approver: Approver;
  cwd?: string;
}): Promise<AgentContext>;
```

Internally it folds `opts` into a `ConfigLayer` via the same `composeLayers` law
the CLI uses, then calls the (now env-agnostic) `buildContext` with
`opts.agents ?? ""`. Behavior matches the CLI's construction _minus_ the ambient
reads; only the construction interface is friendlier and frozen.

## The freeze mechanism (compatibility floor)

A snapshot test (`src/mod.test.ts`) that encodes "no backwards-incompatible
change":

- A hand-maintained **`EXPECTED_PUBLIC_API`** manifest — `{ name, kind }` for
  every frozen export (`kind` ∈ function / interface / typeAlias / variable /
  class). Doubles as the human-readable record of the surface.
- The test runs **`deno doc --json src/mod.ts`** (captures _type-only_ exports,
  which a runtime `import`-and-introspect would miss), extracts the actual
  `{name, kind}` set, and asserts **`EXPECTED ⊆ actual`** — a _floor_, not
  equality.
- **Semantics = the compat promise.** Removing/renaming a frozen export → drops
  from `actual` → CI fails (a breaking change you must consciously confront).
  Kind change (e.g. `function`→`const`) → fails. _Adding_ a new export → test
  still passes (non-breaking, minor-version territory); add a manifest line to
  document it, but nothing forces it.
- **Scope:** `{name, kind}` only — **not** full signatures (`deno doc --json`
  type dumps are brittle). Catches the high-value breaks (removal/rename/kind);
  signature-level freezing is deferred.
- `deno doc --json` needs `--allow-run`, already granted by the `test` task.

## JSR-publish shaping

`deno.json` gains the package shape now (publish itself deferred):

- **`exports`** — `{ ".": "./src/mod.ts" }`.
- **`name`** — `@phibkro/pagu` (JSR scoped).
- **`version`** — `"0.1.0"` (decision 5).

No `deno publish` in CI. JSR's no-"slow-types" requirement (fully-explicit types
on the public surface) is satisfied by our typed code; a
`deno publish
--dry-run` check is deferred to actual publish time.

## Enforcement-ladder placement

This lands the API-stability convention at the **test rung**: the public surface
is `src/mod.ts`, and the floor test guards it in CI. (The stronger CI
single-door rule — forbidding deep-imports around the barrel — is deferred;
in-repo frontends import sensibly and there's no external consumer yet to
drift.)

## Invariants preserved

- **#1** — the capability set stays closed; no public affordance to add an agent
  exec path. The handler-plugin extension point is already gate-never-widen
  (`ReadonlyExec`).
- **Narrow surface** — the smaller the frozen set, the cheaper the compat
  promise and the more room internals have to evolve.

## Testing

- `setup.test.ts`: `createContext` builds a valid `AgentContext` from structured
  opts (no argv) — correct provider / readPaths / envelope; honors `repo`,
  `allow`, `hide`/`reveal`, `handlers`.
- `mod.test.ts`: the floor test (`EXPECTED_PUBLIC_API ⊆ deno doc --json`).

## Files

- `src/mod.ts` (new) — the public barrel + doc comment (stable API + compat
  promise).
- `src/config/setup.ts` — `createContext` (new export); lift `maybeLoadEnvFile`
  out of `buildContext` (env-agnostic core).
- `src/frontends/cli.ts` + `tui.ts` — call `maybeLoadEnvFile` before
  `buildContext` (preserve the terminal frontends' ambient `.env` behavior). ACP
  does **not** get the call — its stdin is the JSON-RPC channel, so it must
  never prompt there (today only `isTerminal()` saves it); ACP relies on the
  editor/process env. The lift makes "only terminal frontends load `.env`"
  explicit (a latent-correctness improvement).
- `src/mod.test.ts` (new) — the floor test.
- `src/config/setup.test.ts` — `createContext` test.
- `deno.json` — `name`/`version`/`exports`.
- Docs: `CONTEXT.md` (v1 table row → ✅ surface+mechanism, version note),
  `README.md` ("Programmatic use" section), `AGENTS.md` (the convention line),
  `docs/CONCEPTS.md` (the "front door" note), `CHANGELOG.md`.

## Migration (one step at a time, CI green between each)

1. Lift `maybeLoadEnvFile` out of `buildContext` into `cli.ts`/`tui.ts` (call it
   before `buildContext`); `buildContext` env-agnostic. CI green (CLI/TUI `.env`
   behavior unchanged).
2. `createContext` in `config/setup.ts` + test (build ctx from structured opts,
   hermetic — no ambient reads). CI green.
3. `src/mod.ts` barrel re-exporting the narrow surface. CI green.
4. `src/mod.test.ts` floor test (`EXPECTED_PUBLIC_API ⊆ deno doc --json`). CI
   green.
5. `deno.json` `name`/`version`/`exports`. CI green.
6. Docs.

## Deferred

- **Extendable capabilities** — letting external consumers define their own
  capabilities (new agent tools). A real future goal, but a genuine security
  surface (invariant #1): when built, make it as safe as possible _and_ warn
  loudly about untrusted extensions/plugins. For now the set is closed; the
  handler-plugin slot is the sanctioned bounded extension point.
- **Ambient/CLI-style loading in `createContext`** — an opt-in (e.g.
  `loadAmbientConfig: true`) to layer the global `config.json` + AGENTS.md under
  the explicit opts, for consumers building a pagu-CLI-clone. Hermetic is the
  default; add this only if a consumer needs it.
- **JSR publish + `1.0.0` + semver tags** — flip at the product v1 milestone;
  the package shape is ready.
- **CI single-door rule** — a `check-layers.ts` rule that the public surface is
  reachable only via `mod.ts` (no deep-imports around it). Add when an external
  consumer exists who could drift.
- **Signature-level freezing** — the floor test catches removal/rename/kind, not
  signature narrowing. Add a `deno publish --dry-run` / typed-API check at
  publish time.
