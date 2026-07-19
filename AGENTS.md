# AGENTS.md — working in pagu

pagu is a sandbox + policy gate for any coding-agent harness. The box enforces a
launch-time policy; the gate adjudicates typed escalation requests outside the
sandbox. Preserve that split.

## Read by task

Start here, then open only what the task needs:

1. `README.md` — install, current CLI, policy example, gate usage.
2. `CONTEXT.md` — durable boundary and threat model.
3. `ROADMAP.md` — current sequence and explicit deferrals.
4. `docs/INVARIANTS.md` — load-bearing claims and their enforcers.
5. `docs/ARCHITECTURE.md` — current module and entrypoint map.
6. `docs/CONCEPTS.md` — policy/gate vocabulary and lifecycle.
7. `docs/WORKFLOW.md` — implementation and handoff loop.

History and decisions:

- `CHANGELOG.md` — shipped history.
- `docs/decisions/` — immutable decision-time records; read ADR-0004 and
  ADR-0005 before changing the box/gate boundary.
- `box/docs/notes/` — prior-art analysis behind the plane split.
- `docs/specs/` and `docs/diagrams/` — pre-pivot design history, not live
  architecture. The corresponding implementation is on `archive/harness` and tag
  `harness-final`.

## Boundary rules

The canonical invariant catalog is `docs/INVARIANTS.md`. In short:

- **Gate never widens by itself.** It derives the exact requested read-only
  child rule or records an operator decision. Applying a grant is a separate
  launch lifecycle.
- **Deny wins.** Project layers attenuate; refusal is covered by deny; compiled
  deny mounts overlay allows.
- **Reads are untrusted.** Repository policy, request prose, and harness-read
  content cannot become authority without a trusted ceiling or operator.
- **Evidence outranks narration.** `--explain`, event entries, and tests bind
  claims to the material actually compiled or retained.

Never put adjudication inside the box or enforcement inside the gate. Never
mount a general control socket into the sandbox. Unsupported enforcement must
fail loud, not fall back to a weaker mode.

## Architecture discipline

- The public SDK front door is `src/mod.ts`; maintain its floor test.
- Keep policy decode/load/compile and tier selection pure. Filesystem, process,
  socket, and terminal work belongs in thin adapters.
- Schema changes are public API: version them, reject unknown fields, add a
  falsifier before implementation, and update explanation/evidence together.
- One source of truth per fact: standing policy for authority, compiled result
  for enforcement, append-only events for decisions, JSON files only as gate
  projections.
- Prefer composition and readonly values over class hierarchies or mutable
  shared state.
- A project policy is hostile input and may only narrow user policy.
- Path containment on an authority path requires canonicalization; lexical
  prefix checks alone are insufficient.

Layer markers are structurally checked:

- `// pure:` — deterministic core with no filesystem/process/socket effects.
- `// effects:` — adapter or state boundary.
- `scripts/check-layers.ts` enforces the surviving import rules.

When a convention matters, move it up the enforcement ladder: prose → comment →
test → type/lint/CI rule.

## Feedback loops

```sh
deno task test
deno task check:docs
deno task ci
nix build .#pagu-box .#pagu
```

`deno task ci` is the full local gate: format, lint, type-check, layer check,
documentation drift check, then tests.

For box/gate capability work, also run a real packaged journey:

1. start the built `pagu gate` outside the sandbox;
2. launch the built `pagu-box` with `--policy` and `--gate`;
3. file a request through `fileRequest` from inside;
4. inspect the retained request → decision → grant events;
5. attempt the relevant falsifier from a real bubblewrap process.

Do not claim relaunch/resume behavior until Slice 5 implements and verifies it.

## Definition of done

- Tests were written before a security-boundary change.
- `deno task ci` is green.
- Both Nix packages build when packaging changed.
- Every documentation path and law binding passes `deno task check:docs`.
- Durable behavior is in `CONTEXT.md`; forward work is in `ROADMAP.md`; shipped
  behavior is in `CHANGELOG.md`.
- Deferred security work is explicit, not silently dropped.
- Capability-path work has a real end-to-end run and an independent-context
  review.
- The ephemeral slice brief and unrelated user changes are not committed.

## Working-tree and command safety

- Search with `rg` / `rg --files` first.
- Preserve unrelated dirty-tree changes.
- Use `apply_patch` for repository file edits.
- Avoid destructive Git and broad recursive filesystem commands.
- Stage new source before Nix builds: flakes only see Git-tracked files.
- Keep temporary repositories outside `/tmp` when testing a box that mounts a
  fresh temporary filesystem there.
- Use non-interactive Git commands and never push unless the user asks.

## Commits

Use Conventional Commits with a why-focused body and this exact trailer:

```text
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Repository identity:

- name: `Philip B. Krogh`
- email: `71797726+phibkro@users.noreply.github.com`
- remote: private `github.com/phibkro/pagu` (`origin/main`)

## Resume order

1. Check `git log --oneline -5` and `git status --short`.
2. Read `CONTEXT.md`, `ROADMAP.md`, and the relevant ADR.
3. Run `deno task ci` before changing the boundary.
4. Take the next explicit roadmap slice; keep the security core small.
5. Verify, document, commit intentionally, and report evidence plus frictions.
