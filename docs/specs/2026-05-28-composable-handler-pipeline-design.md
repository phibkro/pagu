# Composable handler pipeline — design (v1)

> Status: hardened via grill-with-docs (2026-05-28); ready for tdd. Grill
> resolved: the carrier carries `discovered` + `initialBody` (deriving
> `perms`/`discoveredPerms` in-handler, as the code does), not a single `perms`
> field — required for behavior-identity. Roadmap item #2 (CONTEXT.md → Idea
> backlog → "composable handler pipeline"). Authored via brainstorming; to be
> hardened by grill-with-docs, then implemented via tdd. Grounded in the
> proposal–handler model (`docs/CONCEPTS.md`: effects ≅ permissions ≅ types).

## Goal

Make `write/execute.ts`'s hardcoded `cage → approve → run` pipeline a
**composable handler pipeline**: each stage an insertable handler, composed by
`andThen`, so new behavior (policy gates, logging, a critic, plugins) can later
drop in without editing the core. This is the **proposal–handler model made
concrete in code** — a proposal is an effect request; handlers interpret it; a
gate is a handler that can refuse.

**Scope (deliberately narrow, mirrors the loop-substrate v1):**

- **Behavior-identical** structural refactor — no new behavior ships.
- **`write/execute.ts` only.** The `skills`/`tasks` executors are simpler (no
  cage fix loop, different approval) and stay as-is; they adopt the pattern
  later, once proven on `write`.
- **No config-driven pluggability yet.** The _seam_ (named handlers +
  `andThen` + `pipeline`) is the deliverable. Inserting custom/plugin handlers
  is the next increment.

## The model (why these shapes)

Per `docs/CONCEPTS.md` → "the proposal–handler model": the pipeline _is_ the
permission model made explicit. A handler may **gate** (refuse or narrow) a
proposal but **never grant authority beyond the envelope** — the
**gate-never-widen law**, inherited from the permission lattice ("composition
can only hold-or-tighten"). In v1 this is a documented handler contract; it
becomes type-enforced when plugins land. The set of handlers is the TCB — so
invariant #1 survives a (future) pluggable model.

Reuses the loop substrate (`src/loop.ts`): a handler is `Step<Proposal>` — the
same generic `Step<C>` at `C = Proposal`. This gives the deferred **`andThen`**
its first real caller (at the proposal carrier, not the turn carrier),
validating the generic `Step<C>` decision.

## Design

### `src/loop.ts` — implement the deferred `andThen`

```ts
// run a; if it halts (done), don't run b; else run b and return its Flow.
export function andThen<C>(a: Step<C>, b: Step<C>): Step<C>;
// fold a list of steps with andThen (left-to-right).
export function pipeline<C>(steps: Step<C>[]): Step<C>;
```

`andThen(a, b) = async (c) => (await a(c)) === "done" ? "done" : b(c)`.
Short-circuit on `done` is exactly "a gate rejected → skip the rest." Laws (→
tdd law-tests): left/right identity with an always-`continue` no-op step,
associativity, and short-circuit (a `done` step means `b` never runs).

This updates the loop-substrate spec's "deferred" note: `andThen` is now
implemented with a caller; `fanOut` remains deferred.

### `src/write/` — the `Proposal` carrier + handlers

A mutable `Proposal` record handlers thread and mutate (same mutable-carrier
style as the turn over `ctx.log`):

```ts
interface Proposal {
  ctx: AgentContext;
  task: string;
  script: ScriptEntry; // mutated by the cage fix loop
  initialBody: string; // pre-cage body, for the review iteration diff
  discovered: string[]; // cage's absolutized perm output; [] until cage runs
  approved?: boolean; // set by the gate
  outcome: "stop" | "loop"; // the return to the turn loop; default "loop"
  respond: Responder; // the cage handler uses these for fix rounds
  showReply: (entries: Entry[]) => void;
}
type Handler = Step<Proposal>; // (p: Proposal) => Promise<Flow>
```

`Flow` (`continue | done`) drives short-circuit; the verdict/return rides on
`proposal.outcome`. **`discovered` + `initialBody` are the canonical carried
state**; the two perm representations the code relies on are **derived
in-handler**, exactly as today — `perms = readPaths + discovered` (review
display, `approve()` call, run) and
`discoveredPerms = discovered.map(parsePermission)` (the `shouldAutoApprove`
envelope check + `matchesSkillScript`). A single `perms` field would not be
behavior-identical. `respond`/`showReply` ride on the carrier (uniform,
testable) rather than being closed over — the cage handler is the only one that
uses them.

### The v1 handlers (behavior-identical)

- **`cage`** — self-test in the disposable cage + the inner fix loop (push bug →
  `respond()` → take new script, up to `MAX_FIX`) + permission discovery;
  mutates `script` and sets `discovered` (absolutized). Always returns
  `continue` (even a still-failing self-test presents to approval, as today).
- **`approve`** (the gate) — derives `perms`/`discoveredPerms` from
  `discovered`, then
  `auto-approve(envelope) | skill-match | human(show review + advisory)`; sets
  `approved`. On reject: log the decision, set `outcome = "stop"`, return `done`
  (halts → `run` skipped). On approve: log the decision, return `continue`.
- **`run`** — write to scratch, `runScript`, log the result, apply net-output
  gating; set `outcome` (`"stop"` if net/all granted, else `"loop"`); return
  `done`.

`executeScriptProposal` becomes: build the `Proposal`, run
`pipeline([cage, approve, run])(proposal)`, return `proposal.outcome`. Control
flow is identical to today; it's now composed from named handlers.

### Where it lives

- `andThen`/`pipeline` → `src/loop.ts` (the pure combinator core; grows from one
  file — still small, stays a single file until it doesn't).
- `Proposal` + the three handlers + the pipeline assembly → `src/write/`
  (coupling- based co-location: they _are_ the write-capability pipeline).
  Likely `src/write/pipeline.ts`, exported via the `write/` barrel; `execute.ts`
  becomes the thin assembly.

## Testing

- **`andThen` by law** (pure, fake `Step`s, no I/O): identity, associativity,
  short-circuit-on-`done`.
- **The pipeline refactor is behavior-identical** → proven by the existing suite
  staying green (incl. `agent.test.ts`'s respond-flags invariant) + a live
  Ollama run (chat → cage → auto-approve → run), the same bar as the loop
  substrate. The handlers are effectful shell — exercised against the real
  thing, not mocked.

## Success criteria

1. `andThen`/`pipeline` in `src/loop.ts`, law-tested green.
2. `write/execute.ts`'s pipeline reconstructed as
   `pipeline([cage, approve, run])`, the three handlers named and separated.
3. Full `deno task ci` green — behavior-identical.
4. A live Ollama repo-mode run behaves exactly as before.

## Deferred (out of scope for v1)

- **Config-driven pluggability** — inserting custom handlers/plugins via config;
  the point where the gate-never-widen law gets **type-enforced**.
- **Generalizing** the handler pipeline to the `skills`/`tasks` executors.
- **Effect-handler algebra (B)** — operation-granularity interception /
  generators; only if a real need surfaces (pagu's one-action-per-turn shape
  means the turn boundary ≈ the effect site, so boundary-level handlers likely
  suffice).
- `fanOut` (still deferred from the loop substrate).

## Invariants preserved

No change to invariant #1. The refactor only restructures the _orchestration_ of
the existing pipeline; the respond phase, cage perms, approval gate, and runner
are untouched. The gate-never-widen law keeps a future pluggable model safe by
construction. `agent.test.ts`'s respond-flags assertion remains the guard.
