# Standing approvals — the time-boxed temporary ceiling (design)

> Status: **draft 2026-05-29** (brainstorm → grill → tdd). Backlog #15's
> standing-approvals piece (deferred from the durable-gate slice,
> `2026-05-29-async-approval-design.md`). The security-sensitive one: it widens
> what auto-approves without a human, so it touches invariant #3 directly —
> hardened via grill before TDD.

## Goal

Let a human **amortize the gate**: instead of answering the same class of
proposal every turn, authorize it once — "auto-approve anything within these
perms for the next hour" — bounded by a TTL, logged, revocable. The headline use
is taming approval fatigue and enabling #16 scheduled agents (a
human-in-the-loop job that pre-authorizes a class for its run).

## The framing that keeps it safe (the crux)

A standing approval looks like it violates the permission-axis law —
_composition can only hold-or-tighten, never widen_ — because it auto-approves
proposals that **exceed the session allow-envelope**. It doesn't, because it
lives at a different layer:

- The never-widen law governs **envelope construction** — folding config layers
  (`composeLayers` → `buildEnvelope`) into the run's envelope, which can only
  narrow. A grant **never touches `ctx.envelope`**.
- A grant is a **human decision at the auto-approve layer**
  (`shouldAutoApprove`) — the _same authority the gate already exercises_. A
  human approving one out-of-envelope proposal already authorizes a run beyond
  the auto-envelope (that's the gate's job). A grant just **amortizes** that one
  authorization across a _bounded class_ of proposals for a _bounded time_,
  logged. Not a new kind of authority — the gate's authority, batched.
- **Deny always wins.** A grant supplies _allow_-coverage; the **deny is always
  the session's** (concealment / secret write-denies). A grant can authorize
  "write `/repo` for 1h" but can **never** reach a concealed path — by
  construction (see Representation), because the grant has no way to express
  deny.

So invariant #3 holds (the human pre-vets a temporary envelope); the never-widen
_composition_ law is unaffected (grants aren't composition).

## Representation

A standing approval is a human authorization → an **event** (CQRS, like
everything):

- **`grant`** entry: `{ kind: "grant", id, perms: string[], expires: string }` —
  an `id` (`g1`, `g2`, …, addressable for revocation), the authorized **allow**
  permission set, and an **absolute** ISO expiry (log entries are
  timestamp-less; the grant carries its expiry as _data_, absolute so there's no
  clock/created-at ambiguity). A grant is a **time-boxed allow-set, not an
  `Envelope`** — it has no `deny` of its own.
- **`revoke`** entry: `{ kind: "revoke", grant: <id> }` — the append-only
  inverse; ends a grant early. You never mutate the grant.
- **`activeGrants(log, now): PermissionSet[]`** — pure fold: a grant is active
  iff `expires > now` **and** no `revoke` references its id. Expiry and
  revocation are both just fold filters; no cleanup events, no mutation. A fresh
  process re-derives the live grants from the log.

## The auto-approve gate

`shouldAutoApprove` gains the active grants and consults them independently of
repo-mode (a grant _is_ the explicit, scoped, timed enabling):

```
autoApprove = (repoEnabled && withinEnvelope(discovered, sessionEnv))
           || activeGrants.some((g) =>
                withinEnvelope(discovered, { allow: g, deny: sessionEnv.deny }))
```

Two load-bearing details: the grant path is **independent of `repoEnabled`** (so
grants work in non-repo sessions — the headline use), and each grant check uses
the grant's allow **with the session's `deny`** — so concealment wins over a
grant, always. A proposal auto-approved via a grant records that in its decision
rationale ("auto-approved via standing grant `g1`, expires …") for audit.

## Creation — gate-time

- `ApprovalOutcome` gains a payload variant:
  `"approve" | "reject" | "defer" | { grant: { ttlMs: number } }` (now a
  discriminated union — fine pre-launch, per the freeze stance).
- A `grant` outcome **approves the current proposal (runs it) _and_** logs a
  `grant` whose `perms` = **the approved proposal's exact discovered perm set**
  (no auto-generalization — that would be implicit widening the human never
  vetted) and `expires` = `now + ttlMs`. The **orchestrator stamps** the
  absolute expiry (`Date.now()` is fine in the effectful shell).
- Frontends offer it as a gate option ("approve / approve for 1h / reject");
  per-frontend UX, first cut wires at least one.

## Revocation — anytime (the safety valve)

A deliberate asymmetry: **create at the gate, revoke anytime.** Granting
authority is a deliberate in-context act; _removing_ it must always be possible.

- **`/grants`** — list active grants (id, perms, expiry).
- **`/revoke <id>`** — append a `revoke` for that id.

Proactive commands (no proposal), via the `commands.ts` SlashCommand pattern
(TUI + ACP). Targeted revoke by id; revoke-all is sugar, deferred.

## Invariant preservation

- **#3 — the human gate, amortized not removed.** A grant is a human-authored,
  **time-boxed**, **logged**, **revocable**, **bounded** (a fixed perm-set)
  authorization. Auto-approve still fires only within a human-pre-vetted
  envelope — the grant _is_ that pre-vetting, with an expiry.
- **Concealment / deny untouched.** The session deny applies to every grant
  check; a grant cannot express deny, so it can never widen past a concealed
  path.
- **Never-widen composition law untouched.** Grants are decisions, not config
  composition; `ctx.envelope` is unchanged.
- **Blast radius stays statically enumerable + time-bounded.** A grant's reach
  is its `perms` (enumerable) for its `expires` window (bounded); revocation
  shrinks it on demand. Duration doesn't _silently_ widen — the widening is an
  explicit, expiring, logged human act.

## Implementation slice

`grant`/`revoke` entry kinds (schema + codec round-trip + wire-contract floor) →
`activeGrants(log, now)` pure fold → `shouldAutoApprove` consults active grants
(deny applied, repo-mode-independent) → `ApprovalOutcome` `{grant:{ttlMs}}`
variant → `approve` handler logs the grant on that outcome (orchestrator-stamped
expiry) → `/grants` + `/revoke` commands. Property-test the gate law (a grant
authorizes exactly `within(grant.perms) − sessionDeny`, nothing more;
expired/revoked grants authorize nothing).

**Deferred:** proactive grants (create with no proposal), human-specified grant
envelopes (broader than the approved perms, needs gate UX), auto-generalization
(rejected — implicit widening), revoke-all.
