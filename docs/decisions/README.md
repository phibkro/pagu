# Decisions (ADR log)

Dated, statused records of decisions that are **hard to reverse, surprising
without context, and a real trade-off** (the same bar `grill-with-docs` /
`wrap-feature` use). Most resolutions are just a line in `CONTEXT.md` /
`docs/CONCEPTS.md` — _not_ every choice earns an ADR. This log exists so a fresh
agent (every session is an amnesiac new teammate — see ADR-0001) doesn't
re-litigate a settled trade-off: the _why_ is written down, not carried in
anyone's head.

## Format

One file per decision, `NNNN-kebab-title.md`:

```
# ADR-NNNN: Title

- Status: Accepted | Superseded by ADR-XXXX | Deprecated
- Date: YYYY-MM-DD

## Context     — the forces and the question.
## Decision    — what we chose (active voice).
## Consequences — what follows, what we explicitly did NOT do, what's deferred.
```

Append-only: don't rewrite a superseded ADR — add a new one and flip the old
one's Status to `Superseded by ADR-XXXX`. These files are scanned by
`scripts/check-docs.ts` (refs + repo-paths must resolve), so the log can't
silently drift either.

## Index

- [ADR-0001](0001-agentic-workflow-practices.md) — Treat each agent session as
  onboarding a fresh teammate; adopt the team practices that externalize
  knowledge or verify claims.
- [ADR-0002](0002-roadmap-is-the-single-source.md) — `ROADMAP.md` stays the
  single source of truth; no external issue tracker.
- [ADR-0003](0003-per-project-config.md) — per-project `.pagu/config.json`, with
  repo-mode structurally gating its permission grants (designed; TDD pending).
