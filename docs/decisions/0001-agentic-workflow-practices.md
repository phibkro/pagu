# ADR-0001: Agentic workflow — each session is a fresh teammate

- Status: Accepted
- Date: 2026-05-30

## Context

pagu is built primarily by LLM agents, one session at a time. The useful mental
model is **not** "solo dev" but **an amnesiac team**: every session is a new
teammate that must be onboarded from zero, does excellent work, then leaves —
taking all tacit context with it. Three asymmetries vs. a human team decide
which software-team practices are worth adopting:

1. **Extreme bus factor — everyone quits at end of session.** Documentation
   isn't insurance against lost knowledge; it's the _primary transmission
   medium_. The onboarding artifact is the highest-leverage thing in the repo.
2. **Context is the scarce resource, not time.** Ceremony costs an agent almost
   nothing to _write_, but every doc is paid for again at _read_ time, in
   context budget, every session. The cost model inverts: we can afford heavy
   write-time enforcement, but must optimize ruthlessly for read-navigability.
3. **Agents confabulate; "done" is the dangerous claim.** An agent asserts
   completion confidently and sometimes wrongly. Practices that **bind claims to
   verifiable evidence** are worth disproportionately more than for humans.

## Decision

Adopt the software-team practices that either **externalize tacit knowledge** or
**verify a claim**, and skip the ones whose value was coordinating _persistent
humans across time_. Concretely, the filter: _a practice transfers iff it
externalizes knowledge or verifies a claim; it doesn't iff its value was
coordinating persistent people._

Lean into ceremony where it's cheap for an agent and enforces transparency:

- **Onboarding doc + progressive disclosure** — `AGENTS.md` is the tier-0 docs
  map; read-on-demand docs carry frontmatter summaries so headers are scannable
  without loading the body (see the docs-map in `AGENTS.md`).
- **Externalize the _why_** — this ADR log; the glossary (`docs/CONCEPTS.md`);
  Chesterton's-Fence markers in code (`// invariant #1`, `// pure:` /
  `//
  effects:`) that protect non-obvious constraints from amnesiac "cleanup".
- **Bind claims to evidence** — Conventional Commits (work → immutable history);
  tests as executable spec; CI as the merge gate; and **Definition-of-Done as a
  _check_, not a vibe** (`scripts/check-docs.ts` Edge 4 verifies a doc's `src/…`
  path claims point at real files — see the enforcement ladder in `AGENTS.md`).
- **Independent-context review on risky changes** — self-review shares the
  author's blind spots, so a _different-context_ pass is the agentic form of
  code review. For security/capability-path work, "done" requires a live run of
  the headline journey (not a model-stubbed test); a separate reviewer agent
  (`/code-review ultra`, the cage self-test, the advisor) is the escalation.
  Stronger still: a **cold-agent dogfood** (spawn a fresh agent to _implement_
  from the docs/an ADR) reviews the **design**, not just the code — making a
  design executable exposes flaws prose review misses (see the dogfood section
  in `docs/WORKFLOW.md`).
- **Bounded autonomy / least privilege** — already pagu's core thesis (the
  capability ladder, scoped Deno perms); it applies to its own agents too.
- **Session handoff** — the only "standup" that transfers: `wrap-session` writes
  what-changed / what's-verified / next-action to the next teammate.

## Consequences

- A practice gets adopted only via the filter above; we do **not** import
  standups, sprint/estimation, ownership/RACI, or heavyweight ticketing (their
  value is coordinating persistent humans — see ADR-0002 for tracking).
- The doc set stays vanilla markdown, navigable, and CI-validated; new
  conventions should land on the enforcement ladder (prose → comment → test →
  CI), not as prose alone.
- **Deferred:** an "autonomous-run postmortem" practice (a blameless record when
  an unattended run surprises us) — premature until scheduled agents (#16) run
  unattended in anger. The cage already does a bounded version (bug → bounded
  feedback to the model). Tracked in `ROADMAP.md`.
