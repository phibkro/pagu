# Write-back transport — remote decision submission (design)

> Status: **draft 2026-05-30** (brainstorm → grill → tdd). Backlog #14/#15: the
> deferred "write-back capability" — a remote approver submitting a decision
> that the runner appends. Security-sensitive (a network input that gates a run,
> touching the single-writer invariant) — hardened via grill before TDD.

## Goal

Let an **out-of-band** client — a phone, a LAN device — resolve a pending
proposal on a running pagu it isn't otherwise driving: see what's awaiting
approval, and submit approve/reject. The runner runs the script locally; the
remote is just the approve/observe UI. This is what makes a non-co-located
approver (the durable gate, #15) actually reachable, and the spine of the
remote/alerting vision.

## The model (Q1): a transport-agnostic seam + pluggable adapters

Not a daemon, not a synced file — a **seam**. The pure core is `submitDecision`;
the _wire_ is a thin adapter, exactly like providers behind `chat()` and
frontends behind `UI`/`Approver`. First adapter: **HTTP**. (ACP is **already
covered** — `resumePending` resolves a pending proposal at the next ACP prompt,
shipped `b634dc2` — and an editor answers `requestPermission` synchronously, so
it never accumulates pending; no new ACP work.)

## Security framing (Q2) — why a network input is safe to act on

A remote decision is **untrusted input** (like a file read). Three properties
make acting on it safe:

1. **Resolve-only, never create.** An intent can only approve/reject an
   **existing pending proposal** by id. It cannot inject a script, widen perms,
   or create a grant. A forged intent's blast radius is bounded to "resolve a
   proposal the agent already authored _and_ the cage already vetted."
2. **Authenticated submitter — adapter-owned.** A forged `approve` still
   bypasses the human's judgment (the gate's point), so the submitter **must be
   authenticated**. Auth lives in the _adapter_, not the seam: HTTP presents a
   **token**; the seam trusts the adapter to have authenticated.
3. **Runner appends — single-writer preserved.** The remote submits an _intent_;
   the runner validates + appends the `decision` via `resumeTask`. The remote
   never writes the log.

## The seam (Q3)

```ts
submitDecision(ctx, proposalId, verdict: "approve" | "reject")
  : Promise<"resolved" | "not-pending" | "id-mismatch">
```

- Bind + idempotent: checks
  `pendingProposal(ctx.log)?.script.id === proposalId`. No pending →
  `not-pending`; id differs (already resolved / a different one pending) →
  `id-mismatch`; match → `resumeTask(ctx, verdict)` → `resolved`. A
  double-submit is safe (second finds nothing); a stale intent can't resurrect a
  dead proposal. **No new run logic** — pure validation + dispatch to the
  existing resume path.
- `expired` is system-generated (not submitted); a remote **`{grant}`** is
  deferred. Verdict is approve/reject only.

## The HTTP adapter (Q4/Q5)

A **`pagu serve` frontend** (alongside `cli`/`tui`/`acp`/`vm`) — the **one place
a socket opens**, entirely opt-in:

- Its **`Approver` defers** (`"defer"`) — proposals become _pending_ rather than
  blocking on a local human; the listener exposes them.
- A `Deno.serve` listener with a small router (`serveHandler(ctx, token)` — a
  pure `(Request) => Promise<Response>`, testable without a socket):
  - **`GET /pending`** → the current pending proposal (`id`, `perms`, `body`) or
    empty — the "what am I approving" view.
  - **`POST /decision`** `{ proposalId, verdict }` + token → authenticate →
    `submitDecision` → `resumeTask` (runs locally). Maps the result to a status
    (resolved / not-pending / id-mismatch / 401).
- **Auth:** a token, generated + printed at startup (or `--token`/env).
- **Binding: localhost by default**; `--host 0.0.0.0` opt-in for a LAN phone
  (where the token is the only barrier — so mandatory there).

## Invariant preservation

- **#1/#3 — the gate is not bypassed.** The decision is still a human's (now
  authenticated-remote); the runner still appends it; the script still runs only
  under its cage-vetted perms. The remote can't create authority (resolve-only).
- **Single-writer.** Only the runner appends; the remote sends an intent.
- **Minimal TCB, opt-in.** No socket unless `pagu serve` is run. The added TCB
  is the HTTP router + token check + the deferring approver — small, and the
  seam's security logic is transport-independent and unit-tested.

## Implementation slice

`submitDecision` seam (`agent.ts`) → `serveHandler(ctx, token)` router (pure,
fake-Request-tested: GET pending, POST decision, token 401, bad-id mapping) →
`serveMain` frontend (deferring approver + `Deno.serve(serveHandler)`) →
`pagu serve` CLI subcommand (host/port/token flags). Integration-test the live
listener on an ephemeral port (GET pending → POST decision → resolved + ran).

**Deferred:** the full event-stream (`GET /events`, #14) beyond current-pending;
remote `{grant}`; TLS (localhost/LAN + token first; TLS or a reverse proxy
later); multi-session serve (one session per serve process first).
