# pagu — invariants

The single list of pagu's load-bearing claims, each tagged by **how strongly it
is enforced**. This is the documentation analog of the capability ladder: an
explicit tiering of how much each claim is _checked_ versus _trusted_.

This file exists for two reasons. First, the **numbered threat-model
invariants** (`#1`–`#5`) are cited ~15× across `CONTEXT.md` but were never
defined in one place; this is their canonical home, and citations elsewhere
point here. Second, the project's method is denotational — _define the meaning,
derive the code, the laws hold by construction_ — which means a semantic claim
in the docs is only self-defending if something binds it to the code. This file
makes that binding auditable at a glance.

`CONCEPTS.md` owns the _model_ (what the invariants mean and why they compose);
`CONTEXT.md` owns the _consequences_ (threat model, roadmap); this file owns the
_enforcement tier_ of each claim and nothing else. One home per topic.

## The tiers

Each claim carries exactly one tag:

- **`[law: <test>]`** — bound to an executable check; CI fails if code diverges
  from the stated meaning. The strongest tier. The claim is _self-defending_: it
  cannot silently go stale, because a divergence is a test failure. (The
  `<test>` token must be a **substring of a real test name** —
  `deno task
  check:docs` verifies every `[law:]` binds to an existing test.)
- **`[structural]`** — enforced by construction, not by a runtime test: the
  dangerous state is unrepresentable (a capability is absent, a type forbids it,
  a process boundary precludes it). Checked by `deno check` or by the absence of
  an API, not by a property test. Strong, but verify the construction still
  holds when refactoring the thing that makes it true.
- **`[prose: unchecked]`** — a real semantic claim with _no_ mechanical check
  today. These are the staleness risks: nothing fails if the code drifts from
  them. Each is a candidate to promote to `[law]` (a property test would witness
  it) — the "promote?" note says whether that's tractable.
- **`[judgment]`** — a design choice, not derivable or checkable from code by
  construction (it is the thing code is downstream _of_). Not a staleness risk
  because it does not track code; it is what code tracks. Listed so an agent
  knows these are the irreducible human decisions — read these first; the rest
  is downstream.

> **Why `[judgment]` cannot be mechanized.** The denotational arrow runs meaning
> → code; it has no inverse. Many implementations satisfy a given law, and the
> code cannot recover _which_ meaning you intended. So the choice of denotation
> (why a _gradient_ not a binary; why _three_ axes) is human-only by the same
> structure that makes everything else lawful. The right move is to quarantine
> these, not to chase a way to derive them.

---

## Security invariants (the numbered threat-model set)

The canonical definitions of `#1`–`#5`. `CONTEXT.md` → Threat model owns their
attacker-facing consequences; this owns the statement + enforcement tier.

### #1 — No agent exec path

The agent process (`respond`) never holds `write` or `run`; real-effect
execution happens only in a separate, human-gated runner. There is no
`bash`/`exec` tool to gate — security is the _absence_ of the capability.

`[structural]` — enforced by the capability set being closed (no `execute` tool
exported; `mod.ts` floor test fails on a backwards-incompatible surface change)
and by the phase process holding only
`--allow-read=allowlist --allow-net=model`. **Promote?** Partially witnessed by
the golden-scenario containment test
(`examples/golden-scenario/containment.test.ts`), which asserts an unattended
prompt-injected agent cannot escape; that is an end-to-end witness of #1's
_effect_, not of the structural property itself.

### #2 — The boundary is environment + permissions, not perms alone

What a run may touch is bounded by the OS sandbox view _and_ the Deno permission
set, not by either alone. The scoped-isolation roadmap (CONTEXT #5 backlog)
strengthens this toward "out-of-scope paths simply do not exist."

`[structural]` — bubblewrap / sandbox-exec wrap + Deno `--allow-*` floor;
auto-detected, degrades per #5. **Promote?** The envelope half is `[law]` (see
_composition never widens_); the sandbox half is verified by the macOS/Linux
live-verify recipes (asserting `sandbox:` in result entries), which are
integration checks, not property tests.

### #3 — The human gate is the backstop of the capability ladder

Every novel effect (`write`) reaches a human y/n; auto-approve fires _only_
within a pre-vetted envelope / matched skill ceiling / matched grammar. The gate
is never removed, only made rare.

`[structural]` + `[prose: unchecked]` — the gate's _presence_ is structural (the
runner will not run without a decision); the claim that auto-approve _only_
fires within the envelope is the _composition never widens_ law below. The
residual **un-checkable** part is the human's judgment at the gate itself — see
_the residual recogniser_ under un-checked claims.

### #4 — Command policy is deny-by-default

`run_task` / `run_command` fire only for pre-approved procedures / grammar
matches; everything else falls through to `write` + full human review. Inferred
grammars/ceilings are opt-in, never auto-trusted.

`[law: recognize]` (`tasks/grammar.ts` tests: totality, positive-path generator,
negative flag-injection) for the recogniser; `[structural]` for deny-by-default
(absence of a match ⇒ no auto-approve, by control flow).

### #5 — Sandbox tiers degrade without regression

`detectSandbox` falls back (native isolation → bwrap → none) so a weaker host is
never _more_ permissive than intended — it loses hardening, never gains
authority.

`[prose: unchecked]` — **Promote?** Tractable and worth it: a property asserting
that for any tier, the effective authority ⊆ the authority of the
strongest-available tier (no tier _widens_). Currently relies on code review.

---

## Compositional invariants (the three-axis set)

`CONCEPTS.md` → Three axes, three invariants owns the model. Each axis composes
by a law preserving its own invariant.

### Permission axis — composition can only hold-or-tighten, never widen

`effective = (⋃ allows) − (⋃ denies)`; **deny wins over allow unconditionally**,
by type not by order. Composing layers depends on _which_ layers, not their
order, and can only narrow.

`[law: deny wins]` — property-tested (reflexive, `all`-is-top, deny-wins,
allow-monotone, transitive; `src/permissions/` tests, started 2026-05-28). The
strongest-defended claim in the system. The type-level half
(`PermissionSet`/`Envelope` readonly, `ReadonlyExec`) is additionally
`[structural]` via `deno check`.

### Context axis — untrusted context may inform, never instruct

The context axis is a trust gradient (authored → conditional → accumulated-
trusted → accumulated-untrusted). The further down, the less authority a span
may carry. Prompt assembly must preserve the trust label of each log entry and
fence untrusted spans.

`[law: untrusted spans fenced]` + `[prose: unchecked]` — the **mechanical half
is now witnessed** (shipped 2026-05-29, `src/phases/messages.test.ts`): `trust`
labels every log entry (total over the entry union) and `logToMessages` wraps
every untrusted span in a breakout-resistant named fence (`fenceUntrusted` — the
chosen `</untrusted-n>` close tag is absent from the content by construction, so
injected content cannot forge it; the same absent-delimiter guarantee as the log
codec's variable-length tilde fence). A property test exercises the fence
against adversarial content stuffed with close-tag lookalikes. The **semantic
half stays `[prose: unchecked]`** — that the model actually _obeys_ the fence
(told via the `respond.ts` system prompt that fenced content is data, never
instructions) is not checkable here and reduces to the residual-recogniser /
model-behavior question. Still open beyond the per-prompt fence: the trust label
surviving a **cross-session** read (CONTEXT #16 risk (b)) — the
slow-motion-injection hop.

### Policy axis — authority is attested per-invocation, never propagated

A capability's authority is re-verified against its declared ceiling at _each_
invocation (verbatim match for skills, grammar match for `run_command`, cage
ceiling re-check) — never inherited, assumed, or propagated across
servers/calls.

`[structural]` — the cage re-checks at each invocation by control flow.
`[law: recognize]` for the `run_command` half. **Promote?** The
skill-verbatim-match and ceiling-re-check could gain an explicit property
(invoke with a body/perm exceeding ceiling ⇒ reject) if not already covered by
the capability-execute tests.

---

## State / log invariants

### The log round-trips losslessly

`parseLog ∘ serializeLog = id` over arbitrary bodies (including bodies
containing fence characters).

`[law: log round-trips]` — property-tested; this property _found_ the
fence-collision data-loss bug (fixed 2026-05-28 with variable-length fences). A
model case of a semantic claim defending itself.

### The conversation log is single-writer authoritative

Per session, exactly one writer (the runner's host) owns event ordering; clients
read and submit intents. This is what lets remote sync be offset-based with no
CRDT/consensus _for the log itself_ (CONTEXT → State model).

`[prose: unchecked]` — true by current architecture (one runner appends), not
yet enforced against a second writer. **Promote?** Becomes load-bearing only if
the remote-client work (CONTEXT #14) lands; at that point a check that no
non-runner path appends to the canonical log is worth adding. Until then,
`[judgment]`- adjacent: it is a design stance, not yet a contended property.

### The log is always replayable; every approved run is within its envelope

Across any sequence of session operations (`new → prompt → fork → load → …`)
these hold after each step.

`[prose: unchecked]` — **Promote?** This is exactly CONTEXT backlog #7 (model-
based `fc.commands` stateful testing), currently `open`. The single highest-
leverage `[prose]`→`[law]` promotion for the stateful surface; listed in the
roadmap, not yet built.

### Duration does not widen the envelope

A long-running or oft-scheduled agent has the same statically-enumerable blast
radius as a single turn; containment is structural, not runtime-accumulated.

`[structural]` — follows from #1 + the permission axis law (nothing in the loop
grants authority over time). **Promote?** Implied by the other laws rather than
separately tested; a stateful-testing assertion ("envelope after N turns =
envelope after 1") would witness it directly and is a natural addition to #7.

---

## Handler / orchestration invariants

### Handlers tighten, never widen

A handler in the `write` pipeline may gate (refuse/narrow) a proposal but never
grant authority beyond the envelope — a plugin is safe by the _same_ lattice law
as role composition; the set of handlers is the TCB.

`[structural]` (layer 1, shipped 2026-05-28: readonly
`PermissionSet`/`Envelope`/ `AgentContext.envelope`, `deno check`-enforced) +
pending `ReadonlyExec` (layer 2) to make terminal handlers provably non-widening
at the type level (CONTEXT #12). **Promote?** Once `ReadonlyExec` lands this is
fully `[structural]`; until then a terminal handler could in principle widen
`exec.perms` (the gap #12 closes).

### The loop combinators satisfy their algebraic laws

`andThen`/`pipeline`/`fanOut` fold the same `Flow` "or" monoid sharing the
`continue` identity; `fanOut` is the eager-parallel dual of `pipeline`.

`[law: fanOut]` — 6 laws property-tested with `pipeline` as the oracle (shipped
2026-05-29).

---

## Irreducible judgments (read these first)

These are the human-chosen denotations the rest of the system is downstream of.
No test witnesses them; that is correct, not a gap.

- **The trust gradient is a gradient, not a binary.** Choosing four trust levels
  (authored / conditional / accumulated-trusted / accumulated-untrusted) over a
  flat trusted/untrusted split. `[judgment]`
- **There are exactly three axes** (context / permission / policy). The claim
  that every agent-management concept is one of these or a bundle of them — and
  the discipline to reject a fourth primitive. `[judgment]`
- **Security is structural, not policy** (contain a _compromised_ model, not a
  cooperative one). The wedge that picks no-exec + human-gate over
  taint-tracking (cf. CaMeL). `[judgment]`
- **Honest metaphor over familiar metaphor** when they conflict (CONCEPTS →
  design principle). `[judgment]`
- **Small TCB, readable in one sitting** as a hard constraint that overrides
  feature convenience (e.g. declining Effect; keeping the scheduler external).
  `[judgment]`

---

## How to keep this file honest

- A new load-bearing claim in `CONCEPTS.md`/`CONTEXT.md` should appear here with
  a tier, or be a deliberate omission.
- A `[prose: unchecked]` with a tractable promotion is a backlog candidate; when
  its test lands, retag to `[law: <test>]` and link the test.
- A check whether every `[law: <test>]` names a test that exists (and every
  numbered-invariant citation resolves here) is itself a candidate CI link-check
  — the same move as the doc reference-checker (CONTEXT → State model discussion
  of checkable edges). That would make _this file's_ bindings self-defending
  too.
