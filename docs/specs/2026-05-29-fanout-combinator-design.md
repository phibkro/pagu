# `fanOut` — the eager-parallel combinator (design)

> Status: **draft 2026-05-29** (brainstorming → grilling → tdd). Completes the
> loop substrate algebra (`src/loop.ts`) — the v1 milestone item that must land
> before the public API surface is frozen. Backlog #1's `fanOut`.

## Goal

Add `fanOut` to the loop substrate: the **eager-parallel fold of the `Flow`
monoid**, dual to `pipeline`'s lazy-sequential fold, sharing the same `continue`
identity. Lawful by construction; `loop.ts` stays pure, generic, zero-import.

## Honest framing — what fanOut is (and isn't)

`Step<C> = (c: C) => Promise<Flow>` is **not** a Kleisli arrow `C → Promise<D>`
that transforms the carrier — the output is always `Flow`. So a `Step` is an
**effectful predicate over C**: it reads (and may mutate as a side effect) the
carrier and answers `continue`/`done`.

Therefore `fanOut` is **not** a textbook monoidal-category tensor (a product of
carrier *types* `A ⊗ B`). It runs N predicates over one carrier and combines
their `Flow` **answers**. `Flow` is a monoid under "or": `continue` is the
identity (false), `done` absorbs (true). Both `andThen` and `fanOut` fold
branch results through this same monoid; they differ only in **evaluation
strategy**:

| combinator | strategy | execution |
|------------|----------|-----------|
| `pipeline` / `andThen` | sequential, **lazy** | stops at first `done` (short-circuits) |
| `fanOut` | parallel, **eager** | runs all branches, then combines |

## Signature & denotation

```typescript
/**
 * Eager-parallel fold of the Flow monoid: run every branch concurrently over
 * the same carrier, await all, return `done` if ANY branch is `done`, else
 * `continue`. The dual of `pipeline` (lazy-sequential); shares the `continue`
 * identity (`fanOut([])` ≡ always-continue).
 *
 * Contract: branches MUST treat the carrier as read-only. fanOut combines
 * their answers; it does not merge mutations. Concurrent mutation of a shared
 * carrier is a data race — fan out only over read-only carriers (e.g.
 * `Step<ReadonlyExec>`). loop.ts stays carrier-agnostic; the call site
 * guarantees race-freedom by its choice of carrier.
 *
 * A branch that throws propagates (fail-closed) — the returned promise rejects.
 */
export function fanOut<C>(branches: Step<C>[]): Step<C>;
```

Denotation: `⟦fanOut(bs)⟧ = c ↦ (await all bs(c)).reduce(or, "continue")`
where `or(continue, x) = x`, `or(done, _) = done`.

## Race-freedom — call-site responsibility

`loop.ts` is deliberately generic and imports nothing (tested by law). It does
**not** know whether `C` is mutable. The race-freedom guarantee lives at the
call site: fan out only over a read-only carrier. `ReadonlyExec` (shipped) is
exactly that carrier — its `body`/`perms` are `readonly`, so a `Step<ReadonlyExec>`
branch provably cannot mutate them. The mutable carriers (`Exec`, `Proposal`,
`AgentContext`) are untouched; you simply don't fan out over them.

This is the same separation already in place: `loop.ts` defines `Step`/`pipeline`
generically; the capability layer instantiates them at `C = Exec`/`ReadonlyExec`.
`fanOut` follows the identical pattern — no carrier rewrite, opt-in safety.

## Semantics detail

- **No execution short-circuit.** `Step` has no cancellation token, so `fanOut`
  cannot cancel a running branch. All branches are launched concurrently and
  every one is awaited to settlement (`Promise.allSettled`, not `Promise.all` —
  so no branch is orphaned even when another rejects). It short-circuits the
  *result* (any-done), not the *work*. This is the honest parallel semantics and
  the key behavioural difference from `pipeline`.
- **Fail-closed on throw.** After all branches settle: if any rejected, `fanOut`
  rejects with the first rejection reason (fail-closed — a broken gate blocks,
  never silently permits). Otherwise combine the fulfilled `Flow` answers with
  the any-done monoid.

## The laws (validation — fanOut has no consumer yet)

Since `fanOut` ships without a concrete caller, the laws *are* the validation.
All property-tested with `fast-check` (existing test-only dep), generating
arrays of pure branches that return `continue`/`done` and bump an invocation
counter.

1. **Result agreement (keystone).** For read-only branches,
   `await fanOut(bs)(c) === await pipeline(bs)(c)`. `pipeline` is the **oracle**
   — an independent sequential implementation `fanOut` must agree with on the
   result. Not the oracle trap: short-circuit-sequential vs combine-parallel are
   genuinely different implementations that must converge on the answer.
2. **Execution difference.** `fanOut` runs **all N** branches; `pipeline` runs
   only up to and including the first `done`. Assert via invocation counts:
   `fanOut` count == N always; `pipeline` count ≤ N (== index-of-first-done + 1).
3. **Identity.** `fanOut([])` ≡ always-`continue`; shares the `continue` identity
   with `pipeline([])`.
4. **Associativity / flattening.** `fanOut([...xs, ...ys])` result ==
   `fanOut([fanOut(xs), fanOut(ys)])` result.
5. **Commutativity of result.** `fanOut([a, b])` result == `fanOut([b, a])`
   result (the "or" monoid is commutative).
6. **Fail-closed.** A branch that throws → `fanOut` rejects.

## Scope

**In:** `fanOut<C>(branches: Step<C>[]): Step<C>` in `src/loop.ts`; property
tests for the six laws in `src/loop.test.ts`.

**Out:** an `all-done` variant (no consumer — add when one appears); any concrete
caller (multi-agent / author→critic→revise / explore→synthesize remain deferred,
backlog #1); cancellation tokens for true execution short-circuit (the loop
substrate has none today; `fanOut` documents the limitation honestly).

## Migration

Single, additive change — `fanOut` is a new pure function alongside `loop`,
`andThen`, `pipeline`. No existing code changes. CI green after adding the
function and its property tests.

## CONCEPTS.md update

The compositional-spine section notes `loop`/`andThen`/`pipeline` with `fanOut`
deferred. On landing, update it: `fanOut` is the **eager-parallel fold of the
Flow monoid, dual to pipeline's lazy-sequential fold**, sharing the `continue`
identity — and note the honest caveat that `Step` is an effectful predicate
(not a transforming arrow), so this is a monoid lift over `Flow`, not a textbook
monoidal tensor.
