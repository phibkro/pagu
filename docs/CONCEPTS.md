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

> Status: **roles** are designed here, not yet built — see `CONTEXT.md` →
> Roadmap (backlog #2). The base-role behaviour (AGENTS.md / CLAUDE.md fallback,
> global + project, prose-append) already exists and is the seed of this model.

## The wider metaphor catalogue (inspiration)

Computing concepts borrowed from lived experience, when reaching for a name:
folders & documents, trash/recycle bin, desktop, windows, clipboard
(cut/copy/paste), tabs, bookmarks, menus, pages, notebooks, mail / inbox /
envelope / send, address (URL), library, cart/basket, streams / pipes / channels
(plumbing), threads (weaving), keys / locks / tokens, **sandbox** (a child's
safe play area), branch / fork / trunk / tree, cloud, handshake, heartbeat,
daemon / agent / assistant, garbage collection. Reach for one that transfers the
right intuition — and refuse it if it would lie about behaviour.
