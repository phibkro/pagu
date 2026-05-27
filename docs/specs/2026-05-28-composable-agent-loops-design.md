# Composable agent loops — design (substrate, v1)

> Status: design, pending grill-with-docs. Roadmap item #1 (CONTEXT.md → Idea
> backlog). Authored via brainstorming; to be hardened by grill-with-docs, then
> implemented via tdd.

## Goal

Make the agent loop a **composable value**. Today `runTask` is a fixed imperative
`for turn in 1..MAX_TURNS` loop with implicit state. v1 extracts the **turn** as a
named composable unit and the loop as a **combinator**, so future loops (iterative
author→critic review, fan-out/critique, multi-agent) combine cleanly instead of
being bolted onto a hand-written loop.

**Scope (deliberately narrow):** the compositional substrate at **turn granularity**,
as a **behavior-identical** structural refactor. No new user-facing loop ships in v1
— it lays the foundation and proves it by reconstructing the current loop from the
combinator. (Confirmed scope choice: substrate-first over shipping a concrete loop.)

## The algebra (why these shapes)

A turn-step is a Kleisli arrow over the Task/Promise effect. The relevant operations
map to standard algebra:

- **Sequencing distinct steps ↔ composition.** `author ▷ critic ▷ revise` is Kleisli
  composition (`>=>`) — the `andThen` combinator.
- **Fan-out ↔ product.** Combining steps into a tuple/list of results is the
  **monoidal (applicative) product** (`&&&` / `traverse`). Note: "parallel" is an
  *evaluation strategy* layered on the product (`Promise.all` vs. sequential await),
  not the product itself.
- **Iterate-to-stable ↔ fixpoint over a coproduct.** "Repeat a step until done" is
  **not** plain composition. Each step yields `Continue | Done` (a sum), and the loop
  is the fixpoint of compose-then-branch. **Making that continue/stop coproduct an
  explicit type is the keystone of the substrate** — today it's hidden in control
  flow (`"stop" | "loop"` from executors, pure-chat = done, `MAX_TURNS`).

This is why v1's primitive is a step returning an explicit `Flow` coproduct, with
`loop` as the fixpoint. `andThen` (composition) and `fanOut` (product) are the
extensions the type is shaped to accept.

## Approach decision

**Chosen: `ctx`-carrier, behavior-identical extraction.** State stays in `ctx.log`
(threaded implicitly, as today); control flows through the `Flow` coproduct.

Rejected:

- **Explicit immutable carrier now** (`Step = (state) => Promise<{state, flow}>`):
  enables fan-out immediately but touches executors + respond input + persist, risks
  behavior drift, and overshoots the chosen scope.
- **Just extract `runLoop`, no `Step`/combinators:** gives no composability seam; too
  little to call a substrate.

The `ctx`-carrier's limit is the design boundary, not a gap: sequenced steps (`andThen`)
can share one `ctx`, but **fan-out cannot share a mutable `ctx.log`** — parallel
candidates each need their own conversation branch. So fan-out is what will force the
carrier to be purified (Approach 2) when it's actually built. v1 does not foreclose
that; it defers it honestly.

## Design

### New module `src/loop/` (pure control core, barrel-exported)

```ts
// the continue/stop coproduct — the keystone
export type Flow = "continue" | "done";

// the composable unit: one turn; effects threaded through ctx
export type Step = (ctx: AgentContext) => Promise<Flow>;

// fixpoint over Flow — runs step until `done` or `maxTurns`. Ships in v1.
export function loop(step: Step, maxTurns: number): Step;
```

`loop(step, max)` returns a `Step` that runs `step` repeatedly: stop at the first
`done`, otherwise continue up to `maxTurns` iterations, then stop. (Returning a `Step`
keeps `loop` a combinator — a loop is itself a composable unit — rather than a bare
runner.)

**Deferred extensions the type already accommodates** (NOT implemented in v1 — no
caller yet; implemented when a real loop needs them):

- `andThen(a: Step, b: Step): Step` — Kleisli composition; sequences distinct steps,
  short-circuiting on `done`. Its identity/associativity laws get nailed down when the
  first real composition (e.g. author→critic) exists.
- `fanOut(...)` — monoidal product / `traverse`; requires the explicit immutable
  carrier (Approach 2). Multi-agent doorway.

### `agent.ts` (effectful shell) becomes `loop(turn)`

`runTask` keeps building the effectful pieces (`input()` closure, `respond`,
`showReply`, the user-message push, the `try/catch`), and constructs the concrete
`turn` step closing over `respond`, `task`, and the executor dispatch. The body runs
`await loop(turn, MAX_TURNS)(ctx)` inside the existing `try/catch`.

**Behavior-identical mapping** from today's control flow to `turn`'s `Flow`:

| Today (in the `for` loop) | `turn` returns |
| --- | --- |
| skill-invoke executor → `"stop"` | `done` |
| skill-invoke executor → `"loop"` | `continue` |
| command-invoke executor → `"stop"` / else | `done` / `continue` |
| no script in produced (pure chat) | `done` |
| script executor → `"stop"` / else | `done` / `continue` |
| reaching `MAX_TURNS` | `loop`'s bound stops it |

`status` (the `"thinking…"` vs `"continuing…"` message, which depends on the turn
index) becomes the **`loop`'s concern** — it knows the iteration count — rather than
the step's. `persist`, `showReply`, and `ctx.log.push` stay exactly where they are
inside the turn (behavior-identical).

## Testing (verify the algebra, by law)

`src/loop/` is a pure control core → unit-test with **fake steps** (no real I/O):

- `loop` stops on the first `done`.
- `loop` respects `maxTurns` (a step that always returns `continue` runs exactly
  `maxTurns` times, then stops).
- `loop` of a step that is immediately `done` runs it exactly once.

The behavior-identical proof for the shell is the **existing suite staying green** —
especially `agent.test.ts`'s respond-flags invariant (invariant #1 in code). No
behavior change means no test changes beyond the new `loop` unit tests.

## Success criteria

1. `src/loop/` exists with `Step`, `Flow`, `loop`, barrel-exported; `loop` unit-tested
   by law (all green).
2. `runTask` is reconstructed as `loop(turn, MAX_TURNS)(ctx)`; the `turn` step carries
   the full dispatch with the mapping above.
3. The entire existing suite (`deno task ci`) stays green — behavior-identical.
4. A live Ollama run behaves exactly as before (chat, propose, approve, run).

## Deferred (out of scope for v1)

- `andThen` implementation (await a real second loop, e.g. author→critic→revise).
- `fanOut` / parallel candidates + the immutable-carrier purification it forces.
- Multi-agent (independent actors) — the eventual payoff, unblocked by this substrate.

## Invariants preserved

No change to invariant #1 (no agent exec path): the substrate only restructures the
orchestration loop. The respond phase, cage, approval, and runner are untouched; the
turn-step still dispatches to the same capability executors. `agent.test.ts`'s
respond-flags assertion remains the guard.
