# ADR-0002: ROADMAP.md is the single source of truth — no external tracker

- Status: Accepted
- Date: 2026-05-30

## Context

We evaluated whether to manage the roadmap/issues in an external tool — Linear,
GitHub Issues/Projects, or an Obsidian vault — instead of (or alongside) the
in-repo `ROADMAP.md`. The stated concern was **duplication and drift** between a
tracker and the in-repo docs, absent enforced sync workflows; and the risk of
**premature abstraction** for the project's scale. Decision was research-backed
(four parallel research streams: Linear capabilities, single-source-of-truth /
drift patterns, an options comparison, and a read of pagu's current state).

Key findings: drift is _structural_ — an emergent property of two authoritative
copies of the same facts; the only robust fix is one canonical store + derived
views, never two co-equal stores synced by hand or bot. Linear's source of truth
is its cloud (export is one-way/lossy, no JSON round-trip, no offline) and
GitHub Issues/Projects is git-_adjacent_ (data behind an API, not in the clone)
— both break pagu's local-first / offline / minimal-deps / **agent-reads-repo-
files** values and would create the exact second source the concern names. Under
the ADR-0001 "amnesiac team" lens this is decisive: an external tracker is
_invisible_ to the offline agent, which reads the plan as a repo file.

## Decision

**`ROADMAP.md` (in-repo markdown) stays the single canonical source** for the
forward plan, idea backlog, and milestones. No external issue tracker is
adopted. Enforcement stays in-repo: `scripts/check-docs.ts` validates the
canonical doc (refs, invariants, laws, and now repo-path claims — ADR-0001).

- **Obsidian** may be used only as an optional, read-only _lens_ over the same
  git files (the `memory/` vault already is one) — never a second store.
- **GitHub Issues** is deferred until public launch, and then only as a one-way
  _inbox_ for external bug intake (issues → roadmap; `closes #N` for status) —
  never a co-equal plan store.

## Consequences

- Drift is _sidestepped_, not merely managed: one source means there is no
  second copy to diverge.
- The agent can always "know the plan" by reading a repo file, offline, with no
  API or credentials — preserving invariant #5 (offline-capable, minimal core).
- The cost: `ROADMAP.md` has weaker _workflow_ affordances than a real tracker
  (no boards/timelines/state-machine). Accepted for a single-actor, agent-read
  project; mitigated by status sections + concern tags + `git log`.
- **Revisit** this ADR at public launch, when external contributors filing
  issues becomes a job markdown-in-repo genuinely cannot do.
