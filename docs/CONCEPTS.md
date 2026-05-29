# pagu — concepts & mental models

The nouns and verbs of pagu, and the lived-experience ideas they borrow from.
For humans getting oriented and for agents that want the conceptual map. This
file owns **the mental models**; `CONTEXT.md` owns project design / threat model
/ roadmap; `AGENTS.md` owns how-we-work; `INVARIANTS.md` owns the **enforcement
tier** of each load-bearing claim (which are `[law]` / `[structural]` /
`[prose: unchecked]` / `[judgment]`). Each points to the others — one home per
topic, no duplication.

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

| concept                    | borrowed from                    | what it is in pagu                                                                                                                                                   |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **shell**                  | hermit crab (_Paguroidea_)       | the hard, borrowed, disposable casing the soft/untrusted model acts through — the sandboxed runner                                                                   |
| **cage**                   | a rehearsal cage / playpen       | a no-network, scratch-only sandbox where a proposed script is _rehearsed_ (self-test + permission discovery) before a human sees it                                  |
| **envelope**               | an envelope that contains        | the bounded set of permissions a run may use; auto-approve fires only _within_ it                                                                                    |
| **allowlist / deny**       | a guest list                     | which paths/hosts are admitted (grant) or barred (deny)                                                                                                              |
| **hide / conceal**         | hiding something from view       | paths the runner's filesystem view omits and the agent's read refuses — fed by sources (gitignore = VCS, config `hide` globs, default secrets), liftable by `reveal` |
| **conversation / session** | talking; a transcript            | the append-only log _is_ the conversation; a session is one such transcript                                                                                          |
| **script**                 | a script to be performed         | a written procedure the model authors; never run by the author, only _performed_ by the runner after approval                                                        |
| **role**                   | a hat you wear / a part you play | a composable bundle of config + instructions; an agent _carries_ several at once (precise model: a bundle across axes — see **Axes and bundles** below)              |
| **profile**                | a profile = the whole picture    | the resolved agent + config (the result of composing roles onto the base) (precise model: the full assignment over all three axes — see **Axes and bundles** below)  |
| **phase / turn**           | turn-taking in conversation      | one short-lived, scoped step of the loop                                                                                                                             |
| **skill**                  | a skill you have mastered        | a bundled capability: reference files + pre-approved procedures the agent can invoke verbatim without a fresh human gate                                             |
| **task / command policy**  | a task you are permitted to run  | a named project command the agent can invoke by exact name; deny-by-default, opt-in via config; permissions inferred then cached                                     |

## Axes and bundles — two levels, not one flat list

The table above mixes two _levels_, and keeping them apart is what stops the
concept set from feeling slippery as it grows. Some concepts are **pure axes** —
each speaks to exactly one of the three things that determine an agent's
behaviour and blast radius. Others are **bundles** — named, savable groupings
_across_ axes, for convenience, because in practice you don't want to assemble
the axes by hand every time.

The reduction the rest of this file leans on: **managing an agent collapses to
three concerns** — _context_ (what it knows and how it reasons), _permission_
(what it may touch), and _policy_ (what it may do without asking). Those are the
three axes. Everything else is presentation.

**The three axes** (each maps to exactly one concern, each composes by its own
law — see the compositional spine):

| axis            | concern    | what it is                                                                             |
| --------------- | ---------- | -------------------------------------------------------------------------------------- |
| **personality** | context    | prose, instructions, disposition — how it reasons and talks. No access, no capability. |
| **access**      | permission | the envelope: which paths/hosts are granted or denied. The lattice (below).            |
| **policy**      | capability | the auto-approve surface: skill ceilings, task policies, command grammars, MCP allows. |

**Bundles** are partial assignments over those axes, folded by the same laws at
different grain:

| bundle      | what it bundles                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| **skill**   | a bit of context (instructions) + capability (scripts) + permission (ceiling), packaged for one competence |
| **role**    | a personality + an access envelope + some policy, packaged for a _job_                                     |
| **project** | mostly an _access_ contribution (these paths), conventionally anchored to a directory                      |
| **MCP**     | context (what it can query) + capability (new tools) — two axes at once, so a bundle, not an axis          |
| **profile** | the fully-resolved assignment over all three axes — the thing you launch                                   |

**Names vs. today's code (don't rename yet).** These axis names are the _model_;
the code has not adopted them and should not until #17 is actually built (the
model leads, the code follows). The mapping: **access** ≈ the permission half of
today's `role`/`ConfigLayer` (the `allow`/`write`/`deny` envelope);
**personality** ≈ the _prose_ half of a role / `AGENTS.md`; **policy** ≈ today's
`allowedTasks` + skill ceilings + command grammars. Today's **`role`** is the
bundle that carries personality+access(+policy) together — the axes are the
decomposition of it, not a replacement noun. So when this doc says "access" and
the codebase says "role", they are the same thing seen at different grain; the
decoupling (#17 in `CONTEXT.md` → Roadmap) is what would make them separate
nouns in code.

Two consequences worth internalising. First, **a project is not a primitive** —
it dissolves into an access contribution (and maybe a default
personality/policy) the same way gitignore/secrets/config globs all feed the
concealment set. The thing other agents (e.g. Claude Code) get wrong is welding
"which directory" to "which context" to "which conversation"; pagu keeps them as
independent axes that a project _happens_ to contribute to. Second, **the
temptation will always be to add a primitive** — resist it. A new concept earns
axis status only if it speaks to exactly one concern; otherwise it's a bundle (a
composition of the three). Keeping the axis count at three _is_ the conceptual
integrity. (Roadmap status of personality-as-decoupled-axis and
profile-as-composition lives in `CONTEXT.md` → Roadmap; this file owns only the
model.)

**Session is not on this list, by design.** Axes and bundles are _config_ — the
static description of an agent. A **session** is _state_ — a running instance of
a profile, the live event log. The relation is class/instance: many sessions run
off one profile (the scheduled-job model _requires_ this — every firing is a
fresh session off one profile), a session forks without forking its profile, a
profile changes without touching running sessions. This is the same config/state
line the event-sourcing spine draws elsewhere: config is the _input_ to the
fold; the session _is_ the fold.

## The compositional spine

pagu's abstractions are designed to **compose** (see `AGENTS.md` → Values:
functional/compositional, composition over inheritance, algebraic laws for safe
abstractions). The recurring shape: a thing is a **value**, and combining things
is a **lawful merge**.

- **Instructions + roles as markdown.** A role (and the base `AGENTS.md`) is a
  markdown file: **prose body + YAML frontmatter**. This composes beautifully
  because the two halves compose by _different, both-lawful_ rules:
  - **prose** → **concatenate** (a monoid under append; identity = empty). But
    see the **context axis is a trust gradient** (below): the prose that
    composes is not flat text, it is _labelled_ text, and the labels survive the
    fold.
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
    construction_.
  - **Two kinds of deny** (the explicit denies the law anticipated have arrived
    — config `hide`): **hard denies** (the lattice's `⋃ denies` — never lifted)
    and **concealment denies** (a _subtractive hiding overlay_ within `allow`:
    the runner's view omits the path, and the agent read-tool refuses it).
    Concealment denies are the only liftable kind — a config/role `reveal` glob
    un-hides a concealed path. This does **not** breach "never widen":
    concealment only ever constrains paths _already inside `allow`_, and `allow`
    is enforced independently (envelope + Deno `--allow-*`), so `reveal` can
    only restore access **within `allow`**, never grant beyond it. Sources
    feeding the concealment set (gitignore = the VCS source, config globs,
    default secrets) and the `reveal` opt-out are designed in
    `docs/specs/2026-05-29-concealment-sources-design.md`.
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
- **The agent loop as a composable value** (`src/loop.ts`). The loop itself
  follows the same meaning-first method: a turn _means_
  `⟦Step<C>⟧ = C → Promise<Flow>` (an effectful turn yielding the coproduct
  `⟦Flow⟧ = continue | done`), and `⟦loop⟧` is the bounded fixpoint over that
  coproduct. `loop : Step → Step` is **closed over the type** — a loop is itself
  a composable turn — which is what lets loops combine: `andThen` = sequential
  composition; `fanOut` (shipped 2026-05-29) = the **eager-parallel fold of the
  `Flow` monoid**, dual to `pipeline`'s lazy-sequential fold. (`fanOut` is
  derived from the monoidal product via the diagonal, but isn't the bare
  categorical tensor: `Step<C> = C → Flow` is an effectful _predicate_, not a
  carrier-transforming arrow, so what combines is the `Flow` answers, not the
  carrier types. Both `andThen` and `fanOut` fold the same `Flow` "or" monoid —
  `andThen` lazily/sequentially, `fanOut` eagerly/in-parallel — sharing the
  `continue` identity.) `runTask` is just `loop(turn)`.

### The context axis is a trust gradient

The context axis (personality, skill instructions, prior results, observations)
reads as one thing because it all ends up as tokens in a prompt — but it is one
axis with a **trust gradient** running through it, and the gradient is
security-load-bearing, not cosmetic:

- **authored** (personality, base `AGENTS.md`) — static, human-written, trusted
  by provenance.
- **conditional-authored** (skill instructions) — authored too, but in scope
  only while the capability is active.
- **accumulated-trusted** (the agent's own prior proposals/results in the log).
- **accumulated-untrusted** (file contents the agent `read`, tool outputs —
  anything that originated _outside_ the human).

pagu's log already half-encodes this: the event kinds (observation vs proposal
vs result) _are_ points on the gradient. Naming it gives one invariant:

> **Untrusted context may inform, never instruct.** The further down the
> gradient a span sits, the less authority it may carry. Personality can
> instruct; a file the agent read may only inform.

This is the **context-axis sibling of deny-wins**. It changes the prose-monoid
law: the context axis composes not as flat concatenation but as a **monoid over
_labelled_ prose**, where the trust label is preserved through the fold (unlike
permissions, whose provenance is discardable once merged into the effective set
— here it is not, because prompt-assembly must still know which spans are
untrusted, to fence them). This is exactly the diagnosis CaMeL / the dual-LLM
line draws (mixing trust levels in one stream is the root flaw); pagu's _cure_
differs and lives in `CONTEXT.md` → Threat model (taint-tracking vs.
absence-of-execute).

### Three axes, three invariants

The two security invariants in the system are not separate facts; they are the
**same structural job done on different axes**, and there is a third:

| axis       | invariant                                                  | the failure it prevents                                |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| permission | **deny wins, unconditionally** (lattice)                   | composition silently widening the envelope             |
| context    | **untrusted may inform, never instruct**                   | prompt injection via the `read` tool / tool output     |
| policy     | **authority is attested per-invocation, never propagated** | implicit trust propagation (the MCP multi-server flaw) |

The policy invariant is the one that was unstated; the code already enforces it
(verbatim-match for skills, grammar-match for `run_command`, ceiling re-check in
the cage at _each_ invocation — never inherited or assumed). Naming it closes
the symmetry: each axis composes by a law that preserves its own invariant,
lawful by construction. (The security _consequences_ — threat model, prior-art
ledger — live in `CONTEXT.md`; this file owns the structural statement.)

These three **axis** invariants are a different framing from — not a renumbering
of — the numbered **threat-model** invariants in `CONTEXT.md` (#1 no-exec-path,
#2 boundary=perms+env, etc.). They overlap (the permission/deny-wins axis
invariant is the compositional face of threat-model #2's envelope) but partition
the space differently: the axis invariants are organised _by what composes_, the
threat-model invariants _by what an attacker attempts_. Neither subsumes the
other; when citing "the invariants," say which framing.

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

### The command grammar — the safe sublanguage (LangSec)

`run_task`'s exact-name match is the **degenerate** case of a more general idea:
a **command grammar**. A `CommandRule` (`src/tasks/grammar.ts`) describes the
safe sublanguage of one program's invocations — its allowlisted canonical flags
(with typed values) and positionals (patterns are opaque-safe data; paths are
contained to the read scope). `recognize(rule, args, …)` is the recogniser;
exact match = a rule with no free args, so `recognize` **subsumes**
`matchesPolicy`. `run_command` (the read-only tool) uses it to validate
**agent-supplied free args** before running with a fixed read-only ceiling.

This is **LangSec** (language-theoretic security): the danger of "let the agent
run a program with arguments" is the **weird machine** — a permitted program
driven into an escalated state by crafted args (`rg --pre sh`). The fix is to
recognise a **formal grammar of the safe invocations** before acting,
default-deny. Two facts make it sound: (1) **no shell** — we run argv arrays via
`Deno.Command`, not bash (which isn't even context-free), so the language is a
mere token sequence; (2) the safe sublanguage is **regular** (finite flags,
bounded counts), so the recogniser is a fast token state machine — no regex
backtracking, no ReDoS. Recognition is an **allowlist**, never a denylist:
prefix abbreviation (`--pr`→`--pre`) and bundling (`-in`) defeat denylists but
are rejected automatically by "must equal an allowlisted canonical flag." The
load-bearing law: **free args ⇒ read-only ceiling** (no write/net) — the
recogniser is a _filter_ that reduces what's asked; the permission floor + OS
sandbox (+ the planned scoped-namespace tier) remain the boundary that bounds
what's _possible_ if a flag was mis-vetted. Defense in depth, the same shape as
everywhere else in pagu.

## The proposal–handler model: effects ≅ permissions ≅ types

pagu's security model and its (planned) composable orchestration are the **same
idea seen from different sides**. An effect system is, almost exactly, a
permission model: a computation _requests_ an operation it cannot itself perform
("can I have this?"), and a **handler** decides and performs it ("yes — I'll do
it"). That is the **object-capability** model (capabilities-as-effects): you can
only affect what you hold a handle to, and the agent holds _no_ handle to real
execution — it can only propose.

So pagu's two cores are one spine. A **proposal** is an effect request _is_ a
permission request; the chain that processes it before it becomes a real effect
is a **handler pipeline**, and a **gate** is a handler that can refuse:

| permission view              | effect/handler view                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| a proposal's requested perms | the effect it requests                                                                        |
| the **envelope**             | the effect signature the stack auto-grants                                                    |
| `shouldAutoApprove` (within) | "is this effect in the granted set?"                                                          |
| the **human gate**           | the escalation handler for out-of-envelope effects                                            |
| the **cage**                 | a rehearsal handler that _infers_ requested effects (permission discovery = effect inference) |
| the **runner**               | the terminal handler that performs                                                            |

This completes the loop with **command policy as a type system** (above): effect
systems _are_ type-and-effect systems, so **effects ≅ permissions ≅ types**,
unified by two artifacts pagu already has — the **envelope** is the signature,
the **cage** is the checker/interpreter. One idea, three faces (conceptual
integrity).

**The law this hands us — handlers tighten, never widen.** Because the handler
pipeline _is_ the permission model made explicit, its security law falls out of
the permission lattice for free: a handler may **gate** (refuse or narrow) a
proposal but **never grant authority beyond the envelope** — mirroring
"composition can only hold-or-tighten, never silently widen; deny wins
unconditionally." A pluggable handler/plugin is therefore safe by the _same_ law
that makes role composition safe, and invariant #1 survives a pluggable model:
the **set of handlers is the TCB**, each named and inspectable.

**Status:** the `write` pipeline is now a **composable** handler pipeline (v1,
shipped 2026-05-28): `write/execute.ts` is `pipeline([cage, approve, run])` over
`Step<Proposal>` (`src/write/pipeline.ts`), reusing the loop substrate's generic
`Step<C>` + `andThen`. Each handler is named and insertable; a gate is a handler
that can halt. Still value-level — config-driven pluggability (the point where
the gate-never-widen law gets type-enforced) and generalizing to the
`skills`/`tasks` executors are the next increments; algebraic effect handlers
(operation-granularity interception) are the lawful spine underneath, reached
for only if a real need surfaces. (See `CONTEXT.md` → Roadmap.)

**The static sibling — declare locally, aggregate centrally.** Where the handler
pipeline _interprets_ contributions, a plain **list of declarations consumed by
a generalised reader** does the same at the value level. Worked example: slash
commands (`src/commands.ts`) — each `SlashCommand` is declared once as
`{name, description,
run}`, and one list is read by three consumers (the TUI
dispatch, ACP routing, ACP advertisement) via `runCommand`. Same shape as the
Nix module system (declare options locally, `mkMerge` centrally). Not a generic
framework — codify one only at a third instance (rule of three; CLI flags / TUI
slash+pickers / ACP slash+advertise are circling it).

### The approval gate has a lifecycle (derived from the log)

The human gate is not a momentary yes/no — it has a **lifecycle the log encodes
as events**, so an approval can outlive a turn (or a process) and a
non-co-located approver fits. A **proposal** (a `script` the agent authored,
awaiting the gate) moves: `proposed → pending → granted | denied | expired`. The
state is **derived, not stored** — a `script` + its `perms` with no following
`decision` _is_ pending (`pendingProposal(log)` is a pure fold). Two
vocabularies that look alike but aren't:

- **`ApprovalOutcome`** = what a human can answer _now_:
  `approve | reject |
  **defer**`. `defer` means "not now" — it persists the
  pending proposal and ends the turn (the loop stays binary; `defer` is a
  `done`, not a third `Flow`).
- **`Decision.verdict`** = the _terminal recorded_ set:
  `approve | reject |
  **expired**`. `defer` is not a verdict (it's the
  _absence_ of a decision); `expired` is a verdict but **system-generated** (a
  pending proposal past its TTL), not a human answer.

Resuming is re-entrant, not a resumed stack: `runTask` starts a new task (only
when nothing is pending), `resumeTask` resolves the one pending proposal —
reconstructing the run from the logged `script`+`perms`. The decision is
**binary by the nature of the effect** (run the one authored script, or don't);
richer shapes are compositions, not new verdicts — reject-with-feedback is
`reject` + a follow-up message; allow-for-1h is a _standing approval_ (below).
Full design: `docs/specs/2026-05-29-async-approval-design.md`.

A **standing approval** amortizes the gate: "auto-approve anything within these
perms for the next hour." Its artifact is a **`grant`** — a _time-boxed
allow-set_ (`{id, perms, expires}`), **not** an `Envelope` (it has no `deny` of
its own); the auto-approve gate checks a proposal against
`{allow: grant.perms, deny:
sessionDeny}`, so **deny/concealment always wins**
over a grant. A grant is **amortized gate authority at the decision layer**,
_not_ envelope composition — so the never-widen law (which governs config-layer
folding into `ctx.envelope`) is untouched, and #3 holds (the human pre-vets a
temporary, expiring, revocable envelope). Its inverse is a **`revoke`** (end a
grant early); `activeGrants(log,
now)` folds out the expired and the revoked.
Full design: `docs/specs/2026-05-29-standing-approvals-design.md`.

## Derived state and inference chains

A recurring pattern in pagu: effectful inference reads source files and produces
a pure value that downstream logic consumes. The pure core doesn't know or care
where the value came from — it's just a list or map.

```
source files  ──►  effectful inference  ──►  derived value  ──►  pure core
```

All the inference chains in the system:

| Source                                    | Inference fn         | Derived value                          | Pure consumer                                         | Staleness                                           |
| ----------------------------------------- | -------------------- | -------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| git + config `hide`/`reveal` + secrets    | `buildConcealment()` | `Concealment` (predicate + mask paths) | read refusal in `handleRead` + runner OS-sandbox mask | recomputed each `applyRoles()`                      |
| `deno.json` / `package.json` / `Justfile` | `discoverTasks()`    | `DiscoveredTask[]`                     | `run_task` listing, `matchesPolicy`                   | recomputed at session start                         |
| cage denial output                        | `classifyRun()`      | `string[]` needed perms                | `withinEnvelope()`                                    | per-invocation for `write`; lockfile for `run_task` |
| `SKILL.md` + `scripts/*.ts`               | `loadSkill()`        | `Skill` incl. body                     | `invoke_skill` body, ceiling check                    | re-read from disk at each `invoke_skill` call       |
| roles + config + flags                    | `composeLayers()`    | `PaguConfig`, readPaths, envelope      | every downstream decision                             | `setRoles()` / `setProvider()` triggers re-derive   |
| `AGENTS.md` / `CLAUDE.md`                 | `firstPresent()`     | prose `string`                         | system prompt                                         | session start                                       |
| `Entry[]` (append-only log)               | `logToMessages()`    | `ChatMessage[]`                        | model API call                                        | correct-by-construction (pure, no cache)            |

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

**Where this pattern lives in the codebase.** The inference functions cluster
with the types they produce: `gitignoreDenies` with the `Permission` type in
`src/permissions/`, `discoverTasks` and `matchesPolicy` together in `src/tasks/`
(they change together whenever the task policy model changes).

## Source layout and architectural principles

The `src/` directory expresses the architecture directly through its structure.
Four principles shaped it; understanding them lets you navigate and extend
without surprises.

### 1. Hexagonal architecture (Ports and Adapters)

The system has three concentric zones:

**Core** — pure domain types and rules, no I/O:

- `log/` — the event store format (types, parse, serialize)
- `permissions/` — the permission model (envelope, policy, gitignore)

**Application** — capability modules + orchestration:

- `read.ts`, `write/`, `skills/`, `tasks/` — the four capability modules (see
  below)
- `config/` — session configuration (roles, config merge, setup)
- `agent.ts` — the main orchestrator; receives a turn's output, dispatches to
  capabilities, drives the loop

**Adapters** — everything that talks to the outside world:

- `frontends/` (primary adapters, drive the core): `cli.ts`, `tui.ts`
- `providers/` (secondary, model API), `runner/` (secondary, OS execution),
  `phases/` (secondary, respond subprocess)

The invariant: adapters depend on the core; the core never imports from
adapters. Adding a new frontend (ACP, web UI) means adding a file to
`frontends/` that implements `UI` and `Approver` — the core is untouched.

### 2. Coupling-based co-location

Folders group files that **change together**, not files that share a label. The
coupling reveals the name: `tasks/` exists because `discovery.ts`, `policy.ts`,
and `tool.ts` answer the same question ("what project tasks can the agent run,
with what permissions?") and always change together. The folder name is not a
category — it's the responsibility.

Single-file modules are fine when the module is small enough that a folder would
add friction without adding clarity (`read.ts`, `agent.ts`).

### 3. Deep modules with progressive disclosure

Each multi-file module exposes a public interface via `index.ts`. Callers import
from the folder:

```typescript
import { runAdvisor } from "./write/index.ts"; // don't need to know it's in advisor.ts
import { matchesPolicy } from "./tasks/index.ts"; // don't need to know it's in policy.ts
```

The `index.ts` barrel is the module's API surface — the minimum a caller needs
to understand to use it. Implementation files (`advisor.ts`, `policy.ts`, etc.)
are only opened when modifying internals. This is **progressive disclosure**: an
agent reading the codebase can understand the public interface from the barrel,
then drill into the implementation only when necessary. The same principle that
makes a good library makes a good codebase for agents.

**The package front door (`src/mod.ts`).** Distinct from the per-module
`index.ts` barrels (which are _internal_ seams), `src/mod.ts` is the one
**external** public surface — the stable API for embedding pagu in another
program (`createContext` + `runTask` + the loop combinators + the port/reference
types; the capability set stays closed). It's frozen: a floor test fails CI on
any backwards-incompatible change. Internals reached around it aren't part of
the compat promise. The in-repo frontends ship _with_ pagu, so they still import
internals directly; `mod.ts` is the door for everyone else.

### 4. Functional core, imperative shell

Pure functions (no I/O) are separated from effectful ones within each module.
Pagu files begin with a `// pure: X; effects: Y` comment naming the split. The
pure core is always tested directly (unit tests, no mocks). The effectful shell
is tested against real systems where possible (real Deno subprocesses, real HTTP
servers).

This matters for agents working in the codebase: pure functions can be reasoned
about locally; effectful ones require understanding their I/O context.

### Why this architecture suits agentic development

An agent working on pagu reads `index.ts` barrels first — they name the public
API concisely. To add a new capability, the agent looks at an existing
capability folder (`skills/`, `tasks/`) and follows the same pattern: a types
file, a tool definition, an index.ts that exports the interface. The hexagonal
zones tell the agent where a new file belongs without requiring a full system
read. The coupling-based naming means the agent can predict what else will need
to change when it touches a file ("if I'm in `tasks/`, I probably need to update
`policy.ts`, `discovery.ts`, and `tool.ts`").

The deeper point: this architecture minimizes **hidden dependencies** (a
Cognitive Dimensions term — the number of things a contributor must know that
aren't visible in the file they're reading). The barrel files make dependencies
explicit. The hexagonal zones make the direction of dependencies explicit. The
capability folders make co-change relationships explicit. An agent with a fresh
context window can orient itself from the directory tree alone.
