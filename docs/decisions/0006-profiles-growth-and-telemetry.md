# ADR-0006: category profiles, two-tier growth, and the telemetry loop

- Status: Accepted (design; product-lead decision 2026-07-19)
- Date: 2026-07-19

## Context

The gate loop is closed (ADR-0004/0005, slices 4-5): a sandboxed agent's request
is adjudicated and an approval widens the wall. Direction A (real-daily-driver
dogfood) now needs three things the design has gestured at but not pinned: (1)
what **event** produces a request; (2) named **category profiles** for real
work; (3) how a profile **grows** as decisions accumulate, without silently
widening. These are hard to reverse (they shape the policy data model and the
trust story), so they are decided here.

Prior-art spine (`box/docs/notes/composition-split-analysis.md`): OpenFlow
miss-path (an approved escalation compiles into a rule so the miss never
repeats), RFC 9315 dual control loop (telemetry drives widening AND narrowing),
Tailscale tests-in-policy (a policy change is gated by assertions), the
deny-wins asymmetry (narrowing is always safe; widening is adjudicated).

## Decision

### 1. Request triggers — three tiers, named honestly

| Tier              | Trigger                                                                                            | Substrate                                              | Status                                     |
| ----------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| cooperative       | agent calls `pagu request` on a denied op (via CLAUDE.md/skill or Codex escalation)                | none — an explicit call                                | available now                              |
| transcript-mining | parse the boxed session's own output for denial patterns (the method the escalation analysis used) | none — reads existing output                           | available now                              |
| observation       | box logs every denied access, no block-then-ask                                                    | **syscall interception** (seccomp-notify / LD_PRELOAD) | needs the substrate spike (shared w/ next) |
| auto-request      | the denial itself files the request — a captured agent cannot decline to ask                       | **same substrate** + block/await                       | the airtight endpoint (D1)                 |

**Correction to first-cut framing (2026-07-19):** observation is NOT near-free.
A hidden path (tmpfs-overlaid or `/dev/null`-bound) fails _before_ touching any
watchable inode, so inotify/fanotify cannot see the denied access; unprivileged
fanotify (kernel ≥5.13) additionally forbids mount-marks and permission events.
Honest denial observation therefore needs syscall interception — the **same
substrate as tier-3 auto-request**. Observation is cheaper than auto-request
only in that it logs instead of block-then-asks, not in the mechanism. So the
immediately-free dogfood path is **cooperative + transcript-mining**;
observation and auto-request share one substrate spike (evaluate seccomp
user-notif first — bwrap already sets `NO_NEW_PRIVS`, so a filter installs
unprivileged — with an LD_PRELOAD `open`/`stat` shim as the portable fallback,
honestly noting its gaps: static binaries, raw syscalls).

The enforcement layer's own denial is the eventual trigger; until the substrate
lands, a request is an explicit call. **We do not pretend tier-3 containment
exists before it is built** (deny-wins still holds structurally — the wall
blocks regardless; what is missing is the automatic ASK, not the enforcement).

### 2. Category profiles

Profiles are named schema-v0 policies (joining the four legacy presets). Each
denies the secret floor always; they differ on the axes the threat ranking cares
about (secrets ≥ host ≥ repo > egress). Initial set, derived from the real
workloads on this machine:

| Profile        | home  | repo      | net        | host extras             | for                                                                   |
| -------------- | ----- | --------- | ---------- | ----------------------- | --------------------------------------------------------------------- |
| `advisor`      | tmpfs | **RO**    | on         | —                       | read-only review/research (e.g. the Fable advisor); cannot write      |
| `worker`       | tmpfs | RW ($PWD) | on         | nix daemon              | general coding in one repo                                            |
| `proof`        | tmpfs | RW ($PWD) | on (cache) | nix daemon              | Lean/formal builds (lang-bang): heavy build, no cross-repo            |
| `web`          | tmpfs | RW ($PWD) | on         | —                       | TS/node/deno repos (npm/deno net)                                     |
| `infra`        | rw    | RW ($PWD) | on         | nix daemon, `--journal` | homelab/nix — the privileged profile; host reach is its defining axis |
| `orchestrator` | tmpfs | RW ($PWD) | on         | spawn (agent-dispatch)  | multi-agent leads; **never** the herdr control socket                 |

Each profile's `escalation.auto` seeds the safe self-adjudicated widenings for
its category (e.g. `worker`/`proof` auto-grant RO under `/srv/share/projects/**`
session-scoped); `escalation.refuse` always includes the secret floor. Profiles
are checked-in policy files with tests (§4).

### 3. Two-tier growth — accumulate fast, promote slow

A profile MUST NOT auto-mutate on every approval; that lets one careless approve
permanently widen a whole category.

```
grant overlay (per-subject, auto)          profile (shared, curated)
──────────────────────────────────         ─────────────────────────
persist decision → append grant to the     recurring overlay grants are
USER policy overlay for that subject.       PROMOTED into the profile by an
accumulates freely. deny widens UNGATED     explicit, tested, lead-gated step.
(narrowing reach is always safe);           promotion re-runs the profile's
allow widens only through the gate.         assertions before it lands.
```

- **generate → test → convention ladder:** overlay accumulation is the fast
  path; promotion into a shared profile is the tested rung; hand-editing a
  profile is the convention rung (allowed, but gated by §4 tests).
- **deny/allow asymmetry:** a deny entry may be added to a profile or overlay
  from any layer at any time (it only narrows). An allow entry enters a profile
  only by promotion or a tested hand-edit; it enters an overlay only via a gate
  approval. Project-layer policy may still only narrow (ADR-0003/0005).
- **dual drift (telemetry-driven), both directions:**
  - recurring approved request for the same rule → propose promotion into the
    profile;
  - allow grant unused for N days → propose pruning it (drift = an over-wide
    profile). The telemetry proposes; a human/lead disposes.

### 4. Telemetry pipeline

The gate already emits a typed event stream (request / decision / grant / spent
— `src/gate`, `src/request`, the retained `log/`+`events.ts`). The pipeline is a
projection over it, not a parallel system:

1. **emit** — gates write their event log per session (exists).
2. **collect** — an aggregator reads all sessions' logs into one queryable view
   (append-only; the event schema is public API, versioned, floor-tested like
   `src/mod.ts`).
3. **analyse** — queries: top denied paths per profile (→ promotion candidates),
   approval rate per category, unused allows (→ prune candidates), refuse hits
   (→ attempted secret access = security signal).
4. **sink (flow-optional):** flow is the natural evidence plane (its ADR 0005
   grants + evidence model); when present it consumes the stream. Standalone (no
   flow) must work — the aggregator + a local report is the floor.

## Consequences

- Profiles stay small and legible; growth is auditable (overlay = who got what;
  profile diffs = deliberate promotions), and a profile can never silently widen
  (§3 asymmetry + §4 tests).
- The telemetry loop makes prompts _decrease_ (promotion) and reach _shrink_
  (pruning) over time — the RFC 9315 dual loop, realised.
- Dogfooding starts at cooperative + transcript-mining immediately (zero new
  kernel mechanism, no change to a running session's behavior); that data seeds
  §2's `escalation.auto` and §3's promotions. Observation/auto-request follow
  once the shared interception substrate is spiked.
- The event schema becoming public API is a stated cost (versioning + floor-test
  discipline), accepted because the telemetry is a projection of the one log,
  not a second pipeline (single source of truth).

## Rejected alternatives

- **Auto-mutate the profile on every persist** — rejected: one approval
  permanently widening a shared category is the exact tests-in-policy
  regression; promotion must be a gated step.
- **Profiles grow allow-lists freely** — rejected: breaks deny-wins; allow is
  the adjudicated axis, deny is the free one.
- **Only-accrete profiles (no pruning)** — rejected: RFC 9315's loop is
  bidirectional; an unused allow is drift, and silent accretion is how a
  least-privilege profile rots into a broad one.
- **Wait for tier-3 auto-request before dogfooding** — rejected: cooperative +
  transcript-mining yields profile-shaping data now (honestly labelled
  telemetry, not containment) with no new kernel mechanism; the interception
  substrate is a parallel spike, not a blocker.

## Revisit conditions

Revisit when tier-3 auto-request lands (the trigger story changes), when a
second telemetry consumer appears (schema-as-API tightens), or if the initial
profile set proves miscut against real denial data (it is a hypothesis to
falsify with §4's telemetry, not a fixed truth).
