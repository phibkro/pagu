# AGENTS.md — working in pagu

Operating manual for an agent (or human) picking up this codebase cold.

**Docs map** — read the one you need, not all (each doc opens with a `summary`):

- `README.md` — usage: how to run pagu.
- `CONTEXT.md` — durable **design**: rationale, threat model, system/security
  model (the _why_). Put durable design context here, not scattered.
- `ROADMAP.md` — the **forward plan**: in-progress, planned, idea backlog,
  milestones (navigable by concern tag — the _what's next_).
- `docs/WORKFLOW.md` — the **agentic dev lifecycle** (how a fresh agent onboards
  → builds → verifies → hands off), with diagrams. This file is the terse rules;
  WORKFLOW is the picture.
- `docs/ARCHITECTURE.md` — **where things live**: the module-by-module
  inventory.
- `docs/CONCEPTS.md` — the **mental-models** reference (our nouns/verbs + why).
- `docs/INVARIANTS.md` — the **load-bearing-claim catalog** + enforcement tier;
  the canonical home of the numbered invariants (`#1`–`#5`).
- `docs/decisions/` — the **ADR log**: dated, statused records of
  hard-to-reverse decisions (read before re-opening a settled trade-off;
  ADR-0001 = how we work with agents here).
- `docs/specs/` — deep design docs for individual features (drill-down).
- **this file** — _how we work here_. (Cross-tool AGENTS.md standard; pagu reads
  it itself, so keep it concise.)

## What pagu is (the goal)

A local, cross-platform agent you drive like a terminal, where **the model can
never execute anything with real effect**. It reads context and _authors_ a
Deno-TypeScript script into an auditable conversation log; a human (or an
envelope rule) approves; a separate sandboxed process runs it. North star:
_"safe computer use" — terminal-era control with LLM ergonomics, local-first,
the blast radius statically enumerable._

## Invariants (do not break these)

1. **The agent has no real-effect execute capability.** Each conversational turn
   (the `respond` phase) runs as a separate `deno` process with scoped perms
   (`--allow-net=<model>`, `--allow-read=<allowlist>`) — it can read allowlisted
   files and talk to the model, nothing else; it cannot write real files or
   reach the net beyond the model. Real effects happen only in the **runner**,
   triggered by approval. New tools/features must not hand the agent an execute
   path.
2. **The runner's Deno permissions are the security boundary**, not our code.
   Anything that runs untrusted (the cage self-test, the runner) gets
   exactly-scoped `--allow-*` flags.
3. **Reads are untrusted input** (prompt-injection / exfil surface). The
   per-proposal human gate is the backstop; never auto-approve outside a
   pre-vetted envelope.
4. **Security is the invariant; utility is maximized within it.** No compromise
   of #1–#3 for convenience. When they tension, security wins and you surface
   the tradeoff.
5. **Minimal trusted core, offline-capable.** Hand-roll the security core and
   the (trivial) provider HTTP. Take a dependency only for genuinely fiddly
   non-security work, and never one that breaks "runs anywhere."
6. **No Anthropic subscription OAuth** (Anthropic bars it for third-party tools
   — account risk). API-key billing only.

## Values / paradigms

- **Capability-phased FSM:** each phase = a short-lived process with exactly its
  phase's permissions; the runtime, not just code, enforces the bound.
- **The conversation log is the event store** (CQRS): markdown with typed
  `pagu:*` fenced blocks; append-only; the single source of truth.
- **One state, many interfaces.** Flags, config, and the TUI are interfaces onto
  the same settings; the core (`agent.ts`) is I/O-agnostic.
- **Functional, compositional core.** Programs are composed procedures, not
  networks of independent actors (until/unless multi-agent). **Composition over
  inheritance/hierarchy** — hierarchy emerges from composing values, so prefer
  combinators over class trees; lean on category-theory / algebraic thinking for
  abstractions that are safe _and_ powerful (lawful, composable units). The
  forward backlog in `ROADMAP.md` is designed through this lens.
- **Iterate-to-stable, then codify.** Ship the simplest correct thing, let the
  next constraint surface, verify live, commit small.
- **Surface intended behavior.** Decisions encoded in code — precedence,
  defaults, fallbacks, shadowing, merge laws — are documented (in `CONTEXT.md` /
  `docs/CONCEPTS.md`) as _intended behavior_, not left implicit. An undocumented
  rule looks like a bug; transparency is for the next reader and the user.
- **Implicit conventions must have a path to structural enforcement.** Every
  rule that lives only in prose is one refactor away from being silently broken.
  The enforcement ladder: **prose → comment → test → type/lint/CI rule**. Always
  ask which rung the convention is on, and prefer the strongest constraint the
  language or toolchain supports. Examples in this codebase:
  - `// pure:` / `// effects:` → layer checker (`scripts/check-layers.ts`)
    enforces the hexagonal boundary in CI.
  - `// invariant #1` (respond has no exec path) → `agent.test.ts` asserts
    `respondFlags` never grants run/write; R3 in `check-layers.ts` enforces the
    direct import constraint.
  - `gate-never-widen` → `readonly PermissionSet` prevents array mutation;
    `satisfies Capability<Data>` makes literal `entryKind` types mandatory.
  - Public API surface → `src/mod.ts` is the one stable front door; a floor test
    (`mod.test.ts`, `EXPECTED ⊆ deno doc --json`) fails CI if a frozen export is
    removed/renamed. The freeze is **planned for launch, not yet active** (no
    API consumers): _pre-launch_, change a public shape freely for the correct
    model and update the floor (+ `EXPECTED`) deliberately — correctness-by-
    construction outranks compat; _post-launch_, don't break frozen exports, add
    freely. The floor guards against _accidental_ drift, not intentional
    improvement.
  - Phase input shape → a Zod schema (`phaseInputSchema`) validates at
    `readInput()` (`validatePhaseInput`), failing loud on a malformed contract.
    Shallow on `log` + the complex list fields (the orchestrator is the trusted
    producer; the log codec owns entry shape). When adding a new convention,
    document it _and_ ask: what would make violating it a compile error or CI
    failure? Note: `deno lint` validates doc comment structure and types
    (`deno lint --rules` to see available rules); `deno doc` can surface
    undocumented public exports.
- **Clarity over brevity; readability over code-writing velocity; security over
  utility.** When these trade off, optimize in that order — and surface the
  tradeoff. (Hence: `permissions/` not `perms/`, `// effects:` markers, the
  pure/shell split — chosen for the next reader, not for typing speed.)

## Architecture map

Where things live — the module-by-module inventory — moved to
**`docs/ARCHITECTURE.md`** (kept out of this injected-every-turn file). Read it
when you need to find a module; it's listed in the docs-map above.

## Feedback loops

- `deno task test` — the suite (pure cores + HTTP-mocked providers + sandboxed
  integration; the perms are baked into the task). Keep it green.
- `deno task ci` — the full gate (fmt-check + lint + check + test), the same
  thing the pre-commit hook runs. Enable the hook once per clone:
  `git config core.hooksPath .githooks` (skips if deno isn't on PATH).
- `deno task install` — (re)install the `pagu` binary with the right
  `--config`/perms (see Gotchas re: why `--config deno.json` is required).
- **Live-verify** real changes against Ollama (default provider). The no-stdin
  recipe (auto-approves in repo mode, so it's self-contained):
  ```sh
  # NB: keep the repo OUT of /tmp — the bwrap sandbox mounts a fresh --tmpfs
  # over /tmp, which shadows a repo placed there (spurious "No such file").
  R=$(mktemp -d -p "$HOME"); (cd "$R" && git init -q && for f in a b c; do echo x>$f.txt; done && git add -A && git -c user.email=t@t -c user.name=t commit -qm i)
  cd "$R" && pagu 'count the .txt files and write the number to count.txt' --repo </dev/null
  ```
  **Trap:** the installed `pagu` binary reflects committed `main`, **not your
  working tree** — using it to "verify" an uncommitted change silently tests the
  old code. To live-verify uncommitted work, run the entrypoint from the repo:
  `deno run --allow-run --allow-read --allow-write --allow-env <repo>/src/frontends/cli.ts '<task>' --repo </dev/null`
  (deno discovers `deno.json` from the entrypoint's dir).
- The **cage self-test** is the product's own feedback loop: a proposal's bugs
  feed back to the model (bounded) before a human sees it.
- **Test the pure core by law; test the effectful surface against the real
  thing.** Pure cores (the merge monoid, envelope, classify, log codec) get
  unit/property tests — correct by construction. The effectful surface (IO,
  runner, providers) is where errors hide, so exercise the _real system_ — real
  `deno` subprocesses, a real local HTTP server — over isolated mocks. **Caveat
  (hard-won):** a test can use real subprocesses and a real socket yet still be
  hollow if it **stubs the model** — that removes exactly the agent-driven
  behavior (cage discovery, perm inference, multi-turn) where bugs hide. For a
  feature on the security/capability path, "done" includes one real run of the
  headline journey against a live model (Ollama), watched to completion — not a
  model-stubbed "live" test standing in for it. (How `pagu serve`'s cage-perm
  bug was found: it lived in the seam the stub removed.) **`deno task ci:live`**
  is that lane: it drives the eval scenarios through a real model and asserts
  the security floor AND benign utility (the cage bug failed _closed_, so a
  security-only gate misses it — benign>0 is the catch); it **loud-skips**
  (exits 0 with a banner) when no model is reachable, so it never silently
  passes.
- **Definition of done** (verified, not asserted — agents over-claim "done"):
  full `deno task ci` green (not just the tests you touched); docs the change
  touched updated (and `check:docs` green — it now binds `Shipped`/path claims
  to real files, Edge 4); deferred items written down, not dropped; **for
  security/capability-path work, one real run** of the headline journey against
  a live model (above) — and reach for an **independent-context review** (a
  fresh reviewer agent / `/code-review ultra`) before calling such a change
  done, since self-review shares the author's blind spots.
- **Commits:** Conventional Commits (`type(scope): summary`), why-focused body,
  trailer
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
  Remote: private `github.com/phibkro/pagu` (origin/main).

## How to resume, in good spirit

1. Read `CONTEXT.md` (design source of truth) + `ROADMAP.md` (the plan) + this
   file; skim `README.md`.
2. Run the suite; do one live Ollama run to feel the loop.
3. Pick the next slice from **`ROADMAP.md`**. Prefer the lowest-risk thing that
   serves daily usefulness; don't over-build.
4. Respect the invariants above. New provider → behind `chat()`. New frontend →
   behind `Approver`/`UI`. New capability → never an agent exec path.
5. Verify live, commit small, keep the TCB small. When unsure between patterns,
   pick the one that keeps the security boundary clearest.

## Gotchas (hard-won)

- Deno `--deny-read=<child>` breaks `readDir` of its parent → gitignore denies
  are **write-only** at the Deno (tier-1) layer. Read-protection is enforced at
  the **OS-sandbox tier** instead: the runner masks **concealed** paths from its
  filesystem view (`src/runner/sandbox.ts` `readMask` — bwrap binds
  `/dev/null`/empty-tmpfs over them, sandbox-exec denies the read). Concealment
  is multi-source (`src/permissions/concealment.ts`): the VCS source
  (`.gitignore`), config `hide` globs, and an on-by-default secret-glob list,
  minus a `reveal` opt-out. At tier 1 only (no OS sandbox — Windows,
  `--no-sandbox`) the read gap persists.
- Deno reports denied paths _as the script referenced them_ (often relative) →
  `absolutizePerm` before envelope checks.
- `prompt()` returns `null` on piped stdin → use `readLine` (raw stdin).
- Deno flakes only see **git-tracked** files → `git add` new files before a
  build/`deno install`.
- Imports resolve through `deno.json`'s **import map** (bare `@std/…`), so
  versions are pinned in one place. But `deno install --global` **ignores
  `deno.json`** (verified Deno 2.7.14: warns "config file will be ignored", then
  fails `Import "@std/…" not a dependency`) — so the global install MUST pass
  `--config deno.json` (run from the repo root). `deno run/check/test` discover
  `deno.json` automatically; only `install` needs the flag.
- Small models (e.g. qwen3.5:9b) write buggy first scripts; the cage
  compensates. A bigger model (OpenRouter/Anthropic) needs fewer rounds.
