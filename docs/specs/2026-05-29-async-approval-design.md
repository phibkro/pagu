# Async approval — a durable, resumable gate (design)

> Status: **draft 2026-05-29** (brainstorming → grilling → tdd). Backlog #15
> ("approval as an event with a lifecycle"), the deep slice: durable
> suspend/resume of the human gate over the event store, wired toward the #14
> stream. Touches the core loop and the human-gate invariant (#1/#3) — hardened
> via grill before TDD.

## Goal

Today the approval gate is synchronous: the `approve` handler
(`write/pipeline.ts`) `await`s `ctx.approve(script, perms): Promise<boolean>`
inline, and the loop blocks on that promise. A co-located human answers in
seconds; a **non-co-located** approver (a phone, hours later, possibly after the
process exited) cannot. The in-flight gate state lives only in memory and is
lost on exit.

Make the gate **durable and resumable**: a proposal awaiting a decision is a
**pending** state _derived from the log_, and resolving it is a re-entrant
operation — so a fresh process behaves identically to the live one, and a
non-co-located approver fits naturally.

## The wedge: resume = fold the log, not a suspended stack

pagu's loop state is derivable from the single-writer, append-only log (CQRS).
We lean on that instead of adding a third control state:

- **`Flow` stays binary** (`continue | done`). `defer` ends the turn (`done`)
  with the proposal left pending in the log. We do **not** add `suspended` to
  the pure substrate (`loop.ts`) — its monoid laws
  (`andThen`/`pipeline`/`fanOut`) stay intact. (Decision Q1-arch.)
- **Pending is a derived state**, not a stored flag: a `script` + its `perms`
  with no following `decision` ⇒ pending.
  `pendingProposal(log): {script, perms}
  | null` is a pure fold.
- **Resume re-enters the loop** (it cannot resume an unwound stack frame): a
  second entrypoint reconstructs the run from the logged `script`+`perms`.

## Lifecycle

```
proposed ──(cage)──> pending ──approve──> granted ─> run ─> (loop continues)
                        │  ├──reject────> denied  ─> stop
                        │  └──expired───> expired  ─> stop   (TTL at resume-entry)
                        └─ dormant (switch sessions; resumable on reopen)
```

- **`ApprovalOutcome`** = what a human can answer _now_:
  `approve | reject |
  defer`. (Replaces `Promise<boolean>` — the cleaner
  model; see Decisions.)
- **`Decision.verdict`** = the recorded _terminal_ set:
  `approve | reject |
  expired`. Note the asymmetry: **`defer` is not a
  verdict** (it means "no decision yet → pending"); **`expired` is a verdict but
  system-generated**, not a human answer.

## Entrypoints

```ts
runTask(ctx, task); // start a NEW task. Precondition: no pending proposal.
resumeTask(ctx, verdict); // resolve THE pending proposal. verdict: approve|reject|expired.
```

- The frontend folds `pendingProposal(log)` on startup: pending ⇒ present the
  gate, then `resumeTask`; otherwise ⇒ `runTask`.
- `resumeTask`: append the `decision`; on `approve`, reconstruct `{body, perms}`
  from the pending `script`+`perms` and `performRun`, **then continue
  `loop(turn)`** (the result re-enters; the agent may propose — and defer —
  again); on `reject`/`expired`, stop.
- **TTL/expiry** is checked at resume-entry: a pending proposal older than its
  TTL with no decision ⇒ auto-append `expired` + stop, before anything else. TTL
  is optional config; absent ⇒ no expiry (pending persists until resolved).

## Resolved decisions (the grill)

1. **Persist cage-discovered perms as a `perms` entry** at the gate, on _both_
   the deferred and synchronous paths. The latent `PermsEntry` (in the schema,
   never written until now) graduates to a written, floored event. Without it a
   resumed gate couldn't show what the script would run with. The pending
   proposal is then self-contained from the log: `script` + `perms`, no
   `decision`. (Q1)
2. **One pending proposal per session; the session blocks new _tasks_ until it's
   resolved.** The loop suspends at the first deferred gate, so at most one is
   pending; no events may follow a pending proposal (else tail-folding breaks).
   Abandon via **reject** or **expire** — never a buried/superseded proposal.
   (Q2)
3. **`Approver` returns `ApprovalOutcome = "approve" | "reject" | "defer"`** — a
   named, symmetric sum mirroring the log's verdict vocabulary, not a
   `boolean | "defer"` compat-hybrid. `defer` is a **per-proposal** choice (any
   approver may defer a specific gate), not a frontend mode. CLI/TUI never defer
   (unchanged behavior). (Q3)
4. **Two entrypoints; everything a fold of the single-writer log.** No in-memory
   suspended state; a fresh process == the live one. `resolveApproval` (the
   deferred remote write-back target) is later just "validate intent →
   `resumeTask`". (Q4)
5. **Session ops are orthogonal to the gate.** `new`/`fork`/`open` while pending
   leave the proposal dormant-and-resumable in its own session's log (reopening
   re-presents it); Q2's block is per-active-session. `fork` inherits an
   independently-resolvable pending proposal (per-session `decision`,
   per-session ids). No special-casing. (Q5)

## Decision-shape & answer richness (settled pre-grill)

The core decision is **binary by the nature of the effect** — the runner runs
the one fixed authored script, or it doesn't; there is no N-way effect to choose
among. So no multiple-choice / text-answer _verdict primitive_. The richer
interactions are compositions or deferred features, not new verdicts:

- **reject-with-feedback** ("no, do X") = `reject` + a follow-up user `message`
  (the iterate path). At most an **optional `feedback?: string`** on the
  decision.
- **allow-once / allow-for-1h** = the **standing-approvals** slice (deferred): a
  human-authored _temporary ceiling_, reusing `shouldAutoApprove` + the envelope
  lattice — not a new verdict, not a bypass.
- **pick-one-of-several** = speculative; pagu proposes one script per turn. Not
  built.

The `decision`/`perms`/lifecycle shapes are designed for the **correct model**,
not additive-only compat: the API freeze is **planned (post-launch), not
active** — there are no consumers yet, and **correctness-by-construction is the
#1 paradigm, for security and for power**. The `mod.ts` / event-schema floors
guard against _accidental_ drift; we update them deliberately when the model
improves.

## Invariant preservation

- **#1 / #3 — the human gate is never removed.** A deferred proposal is
  **inert** until a real `decision` event is appended — exactly as inert as
  today's synchronous gate, just spread across time/processes. No auto-approve
  is introduced here (that's the deferred standing-approvals slice).
- **Single-writer log.** A remote approver never writes the log; it submits an
  _intent_ over the #14 write-back, and the runner's host appends the
  `decision`. Ordering authority stays with the runner, per session.
- **Blast radius unchanged.** Duration doesn't widen the envelope — a pending
  proposal grants nothing over time; resume runs it under the same perms it was
  proposed (and cage-verified) against.

## Implementation slice

`pendingProposal` fold → persist `perms` at the gate (both paths) → `Approver`
returns `ApprovalOutcome` (update CLI/TUI/ACP) → `approve` handler branches
approve/reject/defer → `resumeTask` entrypoint (reconstruct + run + continue) →
re-entrant startup fold in the frontends → TTL-expiry at resume-entry. Extend
`Decision.verdict` with `expired` + optional `feedback`.

**Deferred:** the remote network transport (`resolveApproval` over #14's
write-back), the standing-approvals temporary ceiling, the staleness marker, and
per-session event ids (the #14 deferral).
