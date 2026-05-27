# pagu — concepts & mental models

The nouns and verbs of pagu, and the lived-experience ideas they borrow from.
For humans getting oriented and for agents that want the conceptual map. This
file owns **the mental models**; `CONTEXT.md` owns project design / threat model
/ roadmap; `AGENTS.md` owns how-we-work. Each points to the others — one home
per topic, no duplication.

## Design principle: lean on lived experience (honestly)

We name and shape abstractions as **interface metaphors** — borrowing concepts
people already understand (the lineage of the _desktop metaphor_: files,
folders, trash). The point isn't decoration; a good metaphor lets a person
predict behaviour from intuition they already have. (Theory: _conceptual
metaphor_ — we understand abstract domains via concrete familiar ones. Its
visual-only cousin is _skeuomorphism_, which we don't care about here — we want
the **concept** to transfer, not the texture.)

The rule: **prefer a familiar metaphor that is honest.** It must not mislead
about what the system actually does. When a metaphor would imply a capability
pagu deliberately lacks (e.g. "the agent runs commands"), pick a different one
(the agent _proposes a script_; a separate _runner_ performs it). Approachable
**and** truthful — that's the bar.

## How we approach design

Concept design is the highest-leverage work here, so we name the lenses. Three
moves, used together — _generate_, _evaluate_, _ground in meaning_:

**Generate** (heuristics that bias what we build):

- **Deep modules** (Ousterhout) — a simple interface over a powerful
  implementation; most value, least surface.
- **Hard to misuse** (Bloch) — the easy path is the correct one; "when in doubt,
  leave it out."
- **Make illegal states unrepresentable** — let the types carry the invariant.
- **Honest metaphor** (above) — borrow lived-experience intuition, never lie
  about behaviour.

**Evaluate** (lenses to critique a design):

- **Norman** — affordances, **mappings**, feedback, **conceptual model**: can a
  person form a correct model of how it works and how to operate it? (The
  _surface you act on_.)
- **Cognitive Dimensions of Notations** (Green & Petre) — a _tradeoff_
  vocabulary for the _structure you reason in_: viscosity (cost of change),
  hidden dependencies, closeness of mapping, consistency, role-expressiveness,
  error-proneness, premature commitment. No dimension is strictly "good" —
  tuning one perturbs another; the value is naming the tradeoff.

**Ground in meaning** (the spine):

- **Denotational / lawful design** (Elliott; algebraic) — define what a thing
  _means_ as a precise value, then derive its operations and laws from that
  meaning, so it's lawful by construction (`⟦a ⋄ b⟧ = ⟦a⟧ ⋄ ⟦b⟧`). pagu already
  does this: the log _means_ a fold over events (CQRS); the envelope _means_ a
  membership predicate (`within`); a role _means_ `(prose, partial-config)` and
  composition is the lawful merge (prose monoid + permission lattice). Define
  the denotation first; the implementation just preserves it.

Held together by **conceptual integrity** (Brooks) — one coherent set of ideas
beats many uncoordinated good ones. These are lenses, not rules: generate, then
evaluate against Norman + Cognitive Dimensions, then check the meaning is
lawful.

## The metaphors we lean on

| concept                    | borrowed from                    | what it is in pagu                                                                                                                  |
| -------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **shell**                  | hermit crab (_Paguroidea_)       | the hard, borrowed, disposable casing the soft/untrusted model acts through — the sandboxed runner                                  |
| **cage**                   | a rehearsal cage / playpen       | a no-network, scratch-only sandbox where a proposed script is _rehearsed_ (self-test + permission discovery) before a human sees it |
| **envelope**               | an envelope that contains        | the bounded set of permissions a run may use; auto-approve fires only _within_ it                                                   |
| **allowlist / deny**       | a guest list                     | which paths/hosts are admitted (grant) or barred (deny)                                                                             |
| **conversation / session** | talking; a transcript            | the append-only log _is_ the conversation; a session is one such transcript                                                         |
| **script**                 | a script to be performed         | a written procedure the model authors; never run by the author, only _performed_ by the runner after approval                       |
| **role**                   | a hat you wear / a part you play | a composable bundle of config + instructions; an agent _carries_ several at once                                                    |
| **profile**                | a profile = the whole picture    | the resolved agent + config (the result of composing roles onto the base)                                                           |
| **phase / turn**           | turn-taking in conversation      | one short-lived, scoped step of the loop                                                                                            |
| **skill**                  | a skill you have mastered        | a bundled capability: reference files + pre-approved procedures the agent can invoke verbatim without a fresh human gate            |
| **task / command policy**  | a task you are permitted to run  | a named project command the agent can invoke by exact name; deny-by-default, opt-in via config; permissions inferred then cached    |

## The compositional spine

pagu's abstractions are designed to **compose** (see `AGENTS.md` → Values:
functional/compositional, composition over inheritance, algebraic laws for safe
abstractions). The recurring shape: a thing is a **value**, and combining things
is a **lawful merge**.

- **Instructions + roles as markdown.** A role (and the base `AGENTS.md`) is a
  markdown file: **prose body + YAML frontmatter**. This composes beautifully
  because the two halves compose by _different, both-lawful_ rules:
  - **prose** → **concatenate** (a monoid under append; identity = empty).
  - **frontmatter (config)** → **structural merge** (below). An agent's
    effective instruction+config = fold its base + composed roles with these
    rules. Hierarchy/inheritance isn't a separate mechanism — it's just the
    _order_ you compose layers in.
- **Config merge law** (the frontmatter half):
  - **scalars** (provider, model, …) → last layer wins (layer-order precedence).
  - **grants** (`allow` reads, `write` dirs) → **union** (commutative; identity
    = ∅) — composing roles _stacks_ scope rather than clobbering it.
  - **permissions as a whole** → a **security lattice, not layer-order
    precedence**: `effective = (⋃ allows) − (⋃ denies)`, and **deny wins over
    allow unconditionally** (by type, not by order). So the permission set
    depends on _which_ layers you compose, not their order, and composition can
    only hold-or-tighten — never silently widen. Safety is preserved _by
    construction_. (Today config carries only grants → union; denies are derived
    from `.gitignore` and already absolute. Explicit denies slot in later under
    the same law.)
  - The per-script + envelope **human gate stays the backstop** — roles set the
    envelope, never a bypass.
- **Skills as role extension.** A skill extends the role denotation with two new
  fields: `files` (paths added to the read allowlist) and `scripts`
  (pre-authored verbatim procedures). Formally:
  `⟦Skill⟧ = (prose, ConfigLayer, files: string[],
  scripts: SkillScript[])`.
  The same composition law applies — a skill folds into the session exactly as a
  role does, and the result is a lawful merge. The `files` field composes by
  union (like grants); `scripts` compose by concatenation (order-independent for
  lookup by name). Crucially, a skill's scripts carry a **permission ceiling**
  (declared in `SKILL.md` frontmatter); the cage verifies at invocation that the
  actual run stays within it — so composition cannot silently widen the
  capability surface.

## Command policy as a type system

The command policy for `run_task` is deliberately isomorphic to a type system:

| type system concept      | command policy equivalent                                    |
| ------------------------ | ------------------------------------------------------------ |
| explicit type annotation | `declared-perms` in config — the task's stated ceiling       |
| inferred type            | cage-discovered permissions — what the task _actually_ needs |
| strict mode              | outside-repo context — explicit annotation required          |
| type cache               | `.pagu/inferred-perms.json` — the lockfile                   |
| type checker             | the cage — validates the run stays within the ceiling        |

On first invocation with no declaration, the cage runs the task with minimal
permissions, collects every Deno denial, and writes the discovered set to
`inferred-perms.json`. Subsequent runs cage against that stored ceiling — fast
(no rediscovery) and safe (ceiling is fixed). Changing the task's behaviour
invalidates the lockfile; the cage detects the new denial and updates it.
Outside a repo (strict mode) the declared permissions are required: inference is
disabled because there is no human-reviewed baseline to anchor against.

The metaphor earns its keep: it gives the user a correct mental model of what
`--declare-perms` does versus not doing it, and it explains why the lockfile
exists and when to delete it (when the task changes in a way that needs new
permissions).

## Derived state and inference chains

A recurring pattern in pagu: effectful inference reads source files and produces
a pure value that downstream logic consumes. The pure core doesn't know or care
where the value came from — it's just a list or map.

```
source files  ──►  effectful inference  ──►  derived value  ──►  pure core
```

All the inference chains in the system:

| Source                                    | Inference fn        | Derived value                     | Pure consumer                       | Staleness                                           |
| ----------------------------------------- | ------------------- | --------------------------------- | ----------------------------------- | --------------------------------------------------- |
| `.gitignore` + git                        | `gitignoreDenies()` | `string[]` denied paths           | read refusal in `handleRead`        | recomputed each `applyRoles()`                      |
| `deno.json` / `package.json` / `Justfile` | `discoverTasks()`   | `DiscoveredTask[]`                | `run_task` listing, `matchesPolicy` | recomputed at session start                         |
| cage denial output                        | `classifyRun()`     | `string[]` needed perms           | `withinEnvelope()`                  | per-invocation for `write`; lockfile for `run_task` |
| `SKILL.md` + `scripts/*.ts`               | `loadSkill()`       | `Skill` incl. body                | `invoke_skill` body, ceiling check  | re-read from disk at each `invoke_skill` call       |
| roles + config + flags                    | `composeLayers()`   | `PaguConfig`, readPaths, envelope | every downstream decision           | `setRoles()` / `setProvider()` triggers re-derive   |
| `AGENTS.md` / `CLAUDE.md`                 | `firstPresent()`    | prose `string`                    | system prompt                       | session start                                       |
| `Entry[]` (append-only log)               | `logToMessages()`   | `ChatMessage[]`                   | model API call                      | correct-by-construction (pure, no cache)            |

**Three staleness strategies** are in use:

1. **Recompute at session start** — cheapest; acceptable because sessions are
   short. Used for: gitignore paths, discovered tasks, agents prose.
2. **Recompute at invocation time** — slightly more expensive; used where the
   derived value must always reflect the current file. Used for: skill script
   bodies (re-read from disk on every `invoke_skill`).
3. **Lockfile + mtime invalidation** — used for expensive inferences that need
   to persist across sessions. Used for: command policy ceilings in
   `.pagu/inferred-perms.json`, invalidated by `filterStaleInferred()` when the
   source file's mtime advances past `inferredAt`.

**The pub-sub angle.** This is a reactive dataflow: source files trigger
recomputation, recomputation updates derived state, derived state drives
behavior. Currently the "subscriptions" are implicit (startup, invocation, or
per-turn). An explicit reactive graph would be overkill at this scale; what
matters is that each inference chain documents its staleness strategy, and that
security-critical derived values (skill bodies, permission ceilings) are
re-validated as close to use as practical.

**Where this pattern lives in the codebase.** The inference functions tend to
cluster with the types they produce: `gitignoreDenies` with the `Permission`
type in `src/permissions/`, `discoverTasks` paired with `CommandEntry` in
`src/command-policy.ts` (they are the most tightly coupled pair currently at the
root — they change together whenever the task policy model changes). Noticing
which files you always open together to understand a piece of behavior is the
right signal for whether co-location is warranted.
