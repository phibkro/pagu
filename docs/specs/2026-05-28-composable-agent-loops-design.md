# Composable agent loops — design (substrate, v1)

> Status: **implemented 2026-05-28** (via tdd). As-built refined three points
> from the design below — noted inline: `Step` is generic over its carrier, the
> module is a single file `src/loop.ts`, and `status` lives in the turn (so
> `loop` stays pure). Hardened via grill-with-docs (2026-05-28). Roadmap item #1
> (CONTEXT.md → Idea backlog). Authored via brainstorming. Grill resolved: turn
> is atomic over the inner cage fix-round loop (unification deferred);
> denotational framing adopted (⟦Step⟧/⟦Flow⟧/⟦loop⟧ + the `loop : Step → Step`
> closure law).

## Goal

Make the agent loop a **composable value**. Today `runTask` is a fixed
imperative `for turn in 1..MAX_TURNS` loop with implicit state. v1 extracts the
**turn** as a named composable unit and the loop as a **combinator**, so future
loops (iterative author→critic review, fan-out/critique, multi-agent) combine
cleanly instead of being bolted onto a hand-written loop.

**Scope (deliberately narrow):** the compositional substrate at **turn
granularity**, as a **behavior-identical** structural refactor. No new
user-facing loop ships in v1 — it lays the foundation and proves it by
reconstructing the current loop from the combinator. (Confirmed scope choice:
substrate-first over shipping a concrete loop.)

## The algebra (denotational — meaning first, operations and laws derived)

Per `CONCEPTS.md`'s design method: define what each thing _means_ as a precise
value; the operations and laws follow, lawful by construction (the same method
that makes the log a fold, the envelope a predicate, a role `(prose, config)`).

- **⟦Flow⟧** = the coproduct `continue | done` (the sum `1 + 1`). The keystone:
  today the continue/stop decision is hidden in control flow (`"stop" | "loop"`
  from executors, pure-chat = done, `MAX_TURNS`); the substrate makes it an
  explicit type.
- **⟦Step⟧** = an effectful turn over a carrier: `C → Promise<Flow>` — "perform
  one turn; signal whether the loop continues." (A Kleisli arrow over the
  Task/Promise effect.) **As-built:** generic `Step<C>`, specialized to
  `C = AgentContext` at the turn. Generic keeps the pure `loop` core free of any
  import from `context.ts`, and is what lets it be tested by law with fake
  carriers.
- **⟦loop(step, n)⟧** = the bounded fixpoint: run `step`; on `continue` recurse
  with `n − 1`; on `done` (or `n = 0`) stop. A completed loop yields `done`.

Operations, derived from the meaning:

- **`loop : Step → Step` — closed over the type.** A loop _is itself_ a
  composable turn, so the combinator returns a `Step`, not a `void` runner.
  Closure is what makes `loop(authorTurn) ▷ loop(criticTurn)` expressible later;
  a runner would take the loop out of the algebra. This is the
  lawful-by-construction reason for the shape — not a style call.
- **`andThen : Step → Step → Step` ↔ composition** (Kleisli `>=>`): sequencing
  distinct steps, `author ▷ critic ▷ revise`. Deferred (no caller yet).
- **`fanOut` ↔ the monoidal (applicative) product** (`&&&` / `traverse`): K
  candidates. "Parallel" is an _evaluation strategy_ layered on the product
  (`Promise.all` vs. sequential await), not the product itself. Deferred (needs
  the immutable carrier).

Laws (these become the tdd law-tests):

- `loop` stops at the first `done` (the fixpoint terminates on `done`).
- `loop(step, n)` runs `step` at most `n` times (the bound is respected).
- `loop` of an immediately-`done` step runs it exactly once.

## Approach decision

**Chosen: `ctx`-carrier, behavior-identical extraction.** State stays in
`ctx.log` (threaded implicitly, as today); control flows through the `Flow`
coproduct.

Rejected:

- **Explicit immutable carrier now**
  (`Step = (state) => Promise<{state, flow}>`): enables fan-out immediately but
  touches executors + respond input + persist, risks behavior drift, and
  overshoots the chosen scope.
- **Just extract `runLoop`, no `Step`/combinators:** gives no composability
  seam; too little to call a substrate.

The `ctx`-carrier's limit is the design boundary, not a gap: sequenced steps
(`andThen`) can share one `ctx`, but **fan-out cannot share a mutable
`ctx.log`** — parallel candidates each need their own conversation branch. So
fan-out is what will force the carrier to be purified (Approach 2) when it's
actually built. v1 does not foreclose that; it defers it honestly.

## Design

### New module `src/loop.ts` (pure control core)

As-built it's a **single file**, not a `src/loop/` folder+barrel — v1 has only
`loop`, so a barrel re-exporting one small file would be the over-architecture
smell (and `CONCEPTS.md` says single-file is right when small). Promote to
`src/loop/` when `andThen`/`fanOut` arrive.

```ts
// the continue/stop coproduct — the keystone
export type Flow = "continue" | "done";

// the composable unit: one turn over a carrier C
export type Step<C> = (c: C) => Promise<Flow>;

// fixpoint over Flow — runs step until `done` or `maxTurns`. Ships in v1.
export function loop<C>(step: Step<C>, maxTurns: number): Step<C>;
```

`loop(step, max)` returns a `Step` that runs `step` repeatedly: stop at the
first `done`, otherwise continue up to `maxTurns` iterations, then stop.
(Returning a `Step` keeps `loop` a combinator — a loop is itself a composable
unit — rather than a bare runner.)

**Deferred extensions the type already accommodates** (NOT implemented in v1 —
no caller yet; implemented when a real loop needs them):

- `andThen(a: Step, b: Step): Step` — Kleisli composition; sequences distinct
  steps, short-circuiting on `done`. Its identity/associativity laws get nailed
  down when the first real composition (e.g. author→critic) exists.
- `fanOut(...)` — monoidal product / `traverse`; requires the explicit immutable
  carrier (Approach 2). Multi-agent doorway.

### `agent.ts` (effectful shell) becomes `loop(turn)`

`runTask` keeps building the effectful pieces (`input()` closure, `respond`,
`showReply`, the user-message push, the `try/catch`), and constructs the
concrete `turn` step closing over `respond`, `task`, and the executor dispatch.
The body runs `await loop(turn, MAX_TURNS)(ctx)` inside the existing
`try/catch`.

**Behavior-identical mapping** from today's control flow to `turn`'s `Flow`:

| Today (in the `for` loop)                 | `turn` returns          |
| ----------------------------------------- | ----------------------- |
| skill-invoke executor → `"stop"`          | `done`                  |
| skill-invoke executor → `"loop"`          | `continue`              |
| command-invoke executor → `"stop"` / else | `done` / `continue`     |
| no script in produced (pure chat)         | `done`                  |
| script executor → `"stop"` / else         | `done` / `continue`     |
| reaching `MAX_TURNS`                      | `loop`'s bound stops it |

`status` (the `"thinking…"` vs `"continuing…"` message): **as-built it lives in
the turn**, not in `loop`. The design said "loop's concern," but a generic,
_pure_ `loop` must not touch `ctx.ui` — so the turn owns `status` (an effect,
per FCIS) and tracks first-vs-subsequent with a closure counter. Cleaner than
the original framing. `persist`, `showReply`, and `ctx.log.push` stay exactly
where they are inside the turn (behavior-identical).

### The turn is atomic over the inner cage fix-round loop

pagu already has **two** loops: the outer turn loop (this substrate) and an
inner **cage fix-round loop** — `executeScriptProposal` receives the `Responder`
(`context.ts:47`) and calls it to feed cage-discovered bugs back to the model
before a human sees the proposal. v1's `Step` is **atomic over that inner
loop**: the turn-step calls `executeScriptProposal` exactly as today and the
fix-round loop stays encapsulated inside the executor. Unifying the two is
explicitly _not_ in scope — the inner loop has a different carrier (one script
proposal + cage results, not the conversation) and a different stop condition
(cage-clean vs. agent-done), so collapsing them now would break
behavior-identity and risk a leaky abstraction. See Deferred.

## Testing (verify the algebra, by law)

`src/loop/` is a pure control core → unit-test with **fake steps** (no real
I/O):

- `loop` stops on the first `done`.
- `loop` respects `maxTurns` (a step that always returns `continue` runs exactly
  `maxTurns` times, then stops).
- `loop` of a step that is immediately `done` runs it exactly once.

The behavior-identical proof for the shell is the **existing suite staying
green** — especially `agent.test.ts`'s respond-flags invariant (invariant #1 in
code). No behavior change means no test changes beyond the new `loop` unit
tests.

## Success criteria

1. `src/loop/` exists with `Step`, `Flow`, `loop`, barrel-exported; `loop`
   unit-tested by law (all green).
2. `runTask` is reconstructed as `loop(turn, MAX_TURNS)(ctx)`; the `turn` step
   carries the full dispatch with the mapping above.
3. The entire existing suite (`deno task ci`) stays green — behavior-identical.
4. A live Ollama run behaves exactly as before (chat, propose, approve, run).

## Deferred (out of scope for v1)

- `andThen` implementation (await a real second loop, e.g.
  author→critic→revise).
- `fanOut` / parallel candidates + the immutable-carrier purification it forces.
- Multi-agent (independent actors) — the eventual payoff, unblocked by this
  substrate.
- **Unifying the inner cage fix-round loop** under the same `loop` combinator. A
  candidate once the substrate proves out, but it needs a different carrier
  (proposal + cage results) and stop condition (cage-clean), so it's a
  deliberate later step, not a v1 collapse.

## Invariants preserved

No change to invariant #1 (no agent exec path): the substrate only restructures
the orchestration loop. The respond phase, cage, approval, and runner are
untouched; the turn-step still dispatches to the same capability executors.
`agent.test.ts`'s respond-flags assertion remains the guard.
