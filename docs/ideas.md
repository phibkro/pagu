# pagu — idea backlog

Forward-looking design explorations, to knock out one at a time. Captured from
brainstorming — **not commitments**. Each entry: the gist, why it fits pagu, the
risk, and rough sequencing. Concrete near-term deferrals live in `DESIGN.md` →
Roadmap; this file is the more speculative / paradigm-level backlog. It's a
personal harness, so packing ideas in is fair game — anything can be removed
later if it doesn't earn its keep.

## The lens (see AGENTS.md → Values)

Functional over object-oriented: programs are **composed procedures**, not
networks of independent actors (until/unless multi-agent). **Composition over
inheritance/hierarchy** — hierarchy and inheritance fall out of composition, so
build compositional primitives and let structure emerge. Lean on
**category-theory / algebraic** thinking for abstractions that are both safe and
powerful: lawful, composable units with clear identities and combinators. Every
item below should be designed through this lens, and must preserve the security
invariants in `AGENTS.md` (above all #1: the agent gets no real-effect exec
path).

## Backlog

1. **Config interop — CLAUDE.md fallback.** _Done._ Read `CLAUDE.md` per scope
   when `AGENTS.md` is absent; prose only, never `.claude/` settings.

2. **Profiles — compositional configuration.** Named, domain-specific config
   bundles (provider/model, allowlist, write/envelope policy, instructions) that
   **compose** across project + environment rather than merely nest. Model a
   profile as a _partial config value_ and composition as the combinator — we
   already have `mergeConfig`; generalize it into an associative merge with a
   clear identity (a monoid), and hierarchy/inheritance falls out for free. Fit:
   a natural extension of today's global+project layering. Risk: low–med.
   **Likely the first concrete one** — it also underpins feature flags (#3).

3. **Composable extensibility — plugins / extensions / feature flags.** Add
   capability without forking the core. Hard constraint: an extension must
   **not** create an agent exec path (invariant #1). So extensions are
   pure/effect-scoped units behind the existing ports — a provider behind
   `chat()`, a frontend behind `UI`/`Approver`, a tool that still only
   _proposes_. Feature flags are just compositional config (ties to #2). Risk:
   **highest** — it's the trust/security surface; design the extension
   _interface_ so the boundary holds by construction, not by convention.
   Brainstorm thoroughly before any code.

4. **ACP (Agent Client Protocol).** Let pagu be driven by ACP clients (editors,
   etc.) — another **frontend** behind the `UI`/`Approver` seam, not a core
   change ("one state, many interfaces"). Fit: clean if it stays a
   transport/frontend adapter; bloat only if it leaks into the core. Bounded and
   optional; good "see how much fits the paradigm" experiment.

5. **Composable agent loops — iterative review / multi-agent.** Treat `runTask`
   (or a smaller turn unit) as a **composable value** so loops combine: an
   author loop feeding a reviewer loop (iterative critique), fan-out/critique
   workflows, etc. Multi-agent is explicitly _later_, but designing the loop now
   as a composed procedure (explicit inputs/outputs, no hidden actor state)
   keeps that door open. The exciting end-state; depends on the compositional
   core maturing (#2/#3). When it arrives, _that's_ when "independent actors"
   become appropriate — and only then.

## How we work the backlog

One at a time, brainstorm → design → implement → verify, smallest viable slice
first. Suggested order: **2 → 3 → 4 → 5** (profiles unlock flags; flags/ports
shape extensibility; ACP is an independent frontend; composed loops are the
capstone). Re-sequence freely as constraints surface.
