# Capability execution pipeline — shared handlers (design)

> Status: **draft 2026-05-28** (authored via brainstorming; to be hardened by
> grill-with-docs, then tdd). Resolves backlog #2's "generalize the handler
> pipeline to the skills/tasks executors" and the **execute** third of backlog
> #6's `Capability` port. Grounded in `src/{write,skills,tasks}/`,
> `src/loop.ts`, and CONCEPTS.md (the proposal–handler model / capabilities-as-
> effects).

## Goal

Collapse the ~40-lines-×-3 of near-identical cage→validate→run→result→net-gate
boilerplate in the skill / task / command executors into **one shared execution
pipeline**, reusing the handler-composition substrate the `write` capability
already uses (`Step<C>` + `andThen`/`pipeline` from `src/loop.ts`). The
security-critical run path then lives in **one audited place**.

## Vocabulary (the `Capability` concept has three phases)

- **discover** — _search/infer_ available actions from the environment (scan
  `.pagu/skills/`, scan `deno.json`, probe PATH). Effectful; produces the
  available set; home of the `legal ∩ present` law (see backlog #1).
- **list** — _present_ discovered actions to the agent (the tool def / enum).
- **execute** — run a chosen action through cage→validate→run.

**This slice is `execute` only.** `discover`/`list` and a capability
**registry** (declare once → advertised + dispatched, removing the 3× branches
in `respond.ts`/`agent.ts`) are deferred to backlog #6's other half.

## Framing — value-level effect handlers (capabilities-as-effects)

Per CONCEPTS.md ("proposal–handler model: effects ≅ permissions ≅ types"): pagu
is **object-capability** — the agent holds no handle to real execution, so it
only _proposes_; **handlers** decide and perform. This module is the
**value-level realization** of that: a proposed action is an effect request; the
handlers (`cage`, `approve`/`autoApprove`, `run`) intercept, decide, and perform
it; `run` is the **terminal handler** (performs in the runner). Interception is
at the **proposal/turn boundary** (`Step<C>` composition), _not_ true algebraic
effect handlers (operation-granularity + continuations) — pagu's
one-action-per-turn shape makes the boundary ≈ the effect site, so boundary
handlers suffice. True algebraic effects remain the deferred "lawful spine."

(Note the noun overload, resolved not blended: the **capability ladder** is the
agent's _tools_ (read/write/invoke_skill/run_task/run_command);
`src/capability/` is those capabilities' shared _execution substrate_.)

## The model — the `Exec` carrier

The core insight: a capability's pre-run logic (cage, ceiling check,
verbatim/policy/grammar validation) all funnels to one outcome — **produce
`(body, perms)` or reject.** Once settled, the run is identical everywhere. So
the carrier threaded through the pipeline is minimal:

```ts
// pure data; the gates fill body/perms, the shared `run` performs it
interface Exec {
  ctx: AgentContext;
  id: string; // log entry id (for the result)
  title: string; // status/label, e.g. "skill: foo" / "rg …"
  body: string; // resolved script body (a gate fills this)
  perms: string[]; // granted permission flags for the real run (a gate fills this)
  scriptArgs?: string[]; // runtime args (skill/command)
  outcome: "stop" | "loop";
}
```

`write`'s richer `Proposal` carrier (which also holds `task`/`respond`/
`showReply`/`initialBody` for its fix-loop + advisor) is the cousin: it reuses
the shared `run` **logic**, without adopting the minimal `Exec` carrier
wholesale (`run` is exposed both as a `Step<Exec>` handler and as the
`performRun` function write's run handler calls).

## Handler decomposition

**Written once, shared (`src/capability/`):**

- **`run`** (`Step<Exec>`) — the terminal handler: scratch →
  `runScript(body,
  perms)` → result entry → `ctx.ui.entries` → net-gate → set
  `outcome`. Every capability ends here; the exfil-gated run path is
  centralized.
- **`autoApprove`** (`Step<Exec>`) — log the `approve` decision + status; shared
  by skill/task/command (write keeps its own `approve` with the human gate +
  advisor).
- **`cageOnce`** — the cage **mechanics only**: scratch →
  `runScript(cagePerms,
  cwd)` → `classify` → `{ class, discovered }`.
  Parameterized by cage-perms + cwd, which already differ across capabilities
  (`run_task` cages _with_ its policy ceiling, cwd `projectBase`; skill/write
  cage read+scratch, cwd `scratch`). Every cage path calls it, including write's
  fix-loop `cage`.

So the genuinely-shared trio is **`cageOnce` + `autoApprove` + `run`** — _not_
`cageWithinCeiling`. **Ceiling enforcement is per-capability**, because the
policies genuinely differ (resolved in grill against `tasks/execute.ts:80–133`):

- **skill** — always check `withinEnvelope(discovered, declared)`; reject if
  exceeded. Never infers.
- **task** — if a declared ceiling exists, check-within-and-reject; **else infer
  - `storeInferred`** (first-run lockfile discovery, _no_ rejection).
- **command** — none (fixed read-only `perms`, no cage at all).

A `cageWithinCeiling(ceiling)` helper (cageOnce + within-check + reject) is
**shared by skill and task-with-ceiling**; task's first-run inference stays in
the task gate. It is a helper, not one of the shared pipeline handlers.

**Per-capability gates (produce `(body, perms)` or reject) — stay in their own
module:**

| capability  | pipeline                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| **skill**   | `[resolveSkillBody, skillCeilingGate, autoApprove, run]` — `skillCeilingGate` = `cageWithinCeiling(declared)`          |
| **task**    | `[genTaskBody, policyGate, taskCeilingGate, autoApprove, run]` — `taskCeilingGate` = cageOnce + infer-or-check fork    |
| **command** | `[grammarGate, autoApprove, run]` — `grammarGate` recognizes + sets a fixed read-only `perms`; **no cage**             |
| **write**   | `[cage, approve, run]` — unchanged shape; `cage` keeps the fix-loop, `approve` the human gate; reuses the shared `run` |

The genuinely-different validation (verbatim file-read / policy+lockfile /
grammar / agent-authored+fix-loop) stays in a small per-capability gate — not
forced into one interface — while the `cageOnce + autoApprove + run` trio is
shared. That's the dedup without a leaky one-size abstraction.

## Where it lives

A new module **`src/capability/`**: `Exec`, `run`/`performRun`, `autoApprove`,
`cageOnce`, `cageWithinCeiling`. Then:

- `write/pipeline.ts` keeps `Proposal` + fix-loop `cage` + human-gate `approve`;
  imports the shared run logic.
- `skills/execute.ts`, `tasks/execute.ts` (+ the `run_command` path in `tasks/`)
  become thin `pipeline([...gates, run])` compositions: a per-capability gate
  file + the shared handlers.

(`src/pipeline/` is taken — `loop.ts`'s `pipeline` combinator +
`write/pipeline.ts`; `src/exec/` is an honest-metaphor violation in a project
whose pitch is "the agent has no exec." `capability/` names the concept and is
the eventual home for the deferred discover/list/registry.)

## Migration — behavior-identical, one capability at a time

1. Extract `run`/`performRun` + `cageOnce` into `src/capability/`; route write +
   the three executors through them. `deno task ci` green; re-pass each
   capability's live-verify.
2. Convert skill → task → command executors to `pipeline([...gates, run])`, one
   at a time, each keeping CI green + live-verified.

The win beyond dedup: the **net-gate + result emission live in one place** — a
small invariant-#2 strengthening, not a behavior change.

## Testing

- **Shared `run`/`cageOnce`** — exercised against real `deno` subprocesses (the
  effectful surface → the real thing, per AGENTS.md).
- **Per-capability gates** — at their own level: `grammarGate` already has its
  recognizer property tests; `policyGate` = `matchesPolicy` (unit); skill
  resolve = file-read (integration). No new mocks.
- **Behavior-identical bar** — the existing suite stays green, and all four
  capabilities are live-verified (skill invoke, `run_task`, `rg` search via
  `run_command`, a `write` proposal) — the same flows already verified this and
  prior sessions.

## Invariants preserved

- **#1** — still the runner as the only exec path; the shared `run` is merely
  where it's centralized. No new capability, no agent exec path.
- **#2** — the runner's Deno perms (+ sandbox) stay the boundary; centralizing
  the net-gate strengthens the audit, doesn't move the boundary.
- Deny-by-default and each capability's ceiling semantics are unchanged — only
  relocated behind shared handlers.

## Deferred

- **discover / list / registry + dispatch** (backlog #6's other half): declare a
  capability once → advertised in `respond.ts` + dispatched in `agent.ts` via a
  descriptor, removing the 3× branches. Its own slice.
- **Alternate execution models behind the seam** — native **MCP** and
  user-authored **plugins**. Caveat: an MCP server _executes the tool itself_,
  bypassing pagu's runner — a different trust model that tensions invariant #1.
  The pipeline must not _assume_ the runner is the only executor, but wiring a
  non-runner executor is a deliberate later decision, not free.
- True **algebraic effect handlers** (operation-granularity) — only if a real
  need surfaces.
- Final **module name** — settle in grill.
