# AGENTS.md — working in pagu

Operating manual for an agent (or human) picking up this codebase cold.
**Usage** lives in `README.md`. **`CONTEXT.md` is the single source of truth**
for project design, rationale, threat model, roadmap, and the idea backlog — put
durable project context there, not scattered across docs. **`docs/CONCEPTS.md`**
is the mental-models reference (our nouns/verbs + why). This file is the _how we
work here_ layer. (It's also the cross-tool AGENTS.md standard — and pagu reads
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
  forward backlog in `CONTEXT.md` → Roadmap is designed through this lens.
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

## Architecture map (where things live)

Each multi-file module exposes its public surface via an `index.ts` barrel;
callers import from the module root, not from internal files.

Pure domain core (unit-tested — change with care + tests first):

- `src/log/` — `pagu:*` block parse/serialize (the event store format).
- `src/permissions/` — `envelope.ts`: `covers`/`within`/`withinEnvelope` (the
  pure containment check); `gitignore.ts`: the VCS source (ignored paths via
  `git ls-files`); `concealment.ts`: the pure multi-source hide policy
  (`buildConcealment` → `conceals` predicate + `maskPaths`; gitignore-compatible
  glob matching; `reveal` subtraction); `concealment-fs.ts`: the **effectful**
  glob source (`enumerateConcealed` — fs walk + `git ls-files`) feeding that
  policy, sibling to `gitignore.ts`; `policy.ts`: a run's permission policy:
  `buildEnvelope` (read/write grants + concealment write-denies, pure) and
  `shouldAutoApprove` (the auto-approve gate).

Capability modules — application layer (also pure/tested; neither holds an exec
path):

- `src/read.ts` — `read` tool: inspect files/dirs, no side effects. Always
  allowed; no approval needed.
- `src/write/` — `write.ts`: author arbitrary scripts (**human gate** at every
  proposal); `review.ts`: pure approval-gate utilities — risk tier badge,
  envelope permission diff, LCS-based iteration diff, `--allow-run` target
  check; `advisor.ts`: optional pre-approval add-on — sends
  `{task, script, perms}` to a configurable model, returns structured
  `[advisory]` flags, fails open. `pipeline.ts`: the capability pipeline as
  composable **handlers** (`cage`, `approve`-gate, `run`) over `Step<Proposal>`
  — `execute.ts` is the thin assembly (`pipeline([cage, approve, run])`).
  Handlers may gate/narrow, never widen the envelope (the proposal–handler
  model, see `docs/CONCEPTS.md`).
- `src/skills/` — `skill.ts`: skill loader — discovers `.pagu/skills/<name>/`
  directories, reads `SKILL.md` (frontmatter + instructions, agentskills.io spec
  — requires `name` and `description` fields matching directory name) and
  `scripts/*.ts` files. Denotation:
  `(prose, ConfigLayer, files: string[],
  scripts: SkillScript[])` — extends
  roles by the same composition law. Skills fold into `AgentContext` at startup.
  `tool.ts`: `invoke_skill` tool — agent names a skill script by
  enum-constrained name; orchestrator resolves the verbatim body from
  `ctx.activeSkillScripts` (agent never copies content); cage validates within
  the declared ceiling; auto-approved on match.
- `src/tasks/` — `policy.ts`: parses `allowed-tasks` config into `CommandEntry`
  objects (deny by default; only listed tasks may run via `run_task`).
  `discovery.ts`: scans `deno.json`, `package.json`, `Justfile` at startup to
  surface available tasks for enum completion. `inferred-perms.json`
  (`.pagu/inferred-perms.json`, gitignored) is the permission lockfile written
  by the first cage run and read by subsequent runs — analogous to a
  type-inference cache; delete it when a task's permission requirements change.
  `tool.ts`: `run_task` tool — agent passes an exact command string
  (enum-constrained to the policy); first run discovers permissions via cage and
  writes lockfile; second run cages against stored ceiling; auto-approved within
  ceiling.

### The capability ladder

The agent has four tools, ordered by how much pre-vetting the approval path
requires:

| tool           | what it does                             | approval path                            |
| -------------- | ---------------------------------------- | ---------------------------------------- |
| `read`         | inspect files/dirs, no side effects      | always allowed (no approval needed)      |
| `write`        | author arbitrary scripts                 | **human gate** at every proposal         |
| `invoke_skill` | run a pre-authored skill script verbatim | auto-approved (verbatim match + ceiling) |
| `run_task`     | run a named project task from policy     | auto-approved (policy match + ceiling)   |

New tools and features must not hand the agent a path outside this ladder.
`invoke_skill` and `run_task` expand utility without widening the blast radius:
the cage still validates permissions, and the orchestrator verifies the script
body matches verbatim pre-approved content before any execution.

Orchestrator:

- `src/agent.ts` — **the I/O-agnostic core**: `runTask(ctx, task)` +
  `AgentContext`/`Approver`/`UI`. The one seam between core and frontends.
  `runTask` is `loop(turn, MAX_TURNS)(ctx)` — it builds the effectful `turn`
  step and runs it through the `loop` combinator below.
- `src/loop.ts` — **pure control core**: the composable loop substrate. `Flow`
  (`continue | done` coproduct), `Step<C>` (`C → Promise<Flow>`, a turn), and
  `loop : Step → Step` (the bounded fixpoint, closed over the type so a loop is
  itself a composable turn). Generic over the carrier so it imports nothing —
  tested by law. `andThen` (Kleisli composition, short-circuit on `done`) +
  `pipeline` (the `andThen`-fold) are implemented — the handler pipeline
  (`src/write/pipeline.ts`) is their first caller, at `C = Proposal`. `fanOut`
  (monoidal product) is still deferred.

Primary adapters (frontends):

- `src/frontends/cli.ts` — one-shot frontend (stdin approver).
  `src/frontends/tui.ts` — REPL frontend (colored, multi-turn; slash commands +
  arrow-key pickers via `src/frontends/select.ts`). `src/frontends/acp.ts` —
  **ACP agent frontend** (`pagu --acp`): pagu driven by an editor client (e.g.
  Zed) over JSON-RPC/stdio via `@agentclientprotocol/sdk` —
  `acpUI`/`acpApprover` map the same UI/Approver seam onto ACP
  `session/update` + `session/request_permission`; each ACP session = one pagu
  conversation. The runner stays the only exec path; pagu declines the client's
  terminal/fs capabilities (invariant #1 holds across frontends).
  `src/frontends/serve.ts` — **HTTP write-back frontend** (`pagu serve`): runs a
  task with a _deferring_ approver, then exposes the pending proposal over HTTP
  (`GET /pending` / `POST /decision` + Bearer token) so an out-of-band approver
  resolves it (`serveHandler` = the pure router; `submitDecision` in `agent.ts`
  = the transport-agnostic, resolve-only seam). The **only** frontend that opens
  a socket: it re-execs itself with `--allow-net` scoped to the bind address
  (the `pagu vm` launcher pattern), so the orchestrator stays net-less. All
  frontends differ _only_ in UI + Approver.

Secondary adapters:

- `src/providers/chat.ts` — `chat()` **dispatcher** (OpenAI Chat Completions,
  default) → `anthropic.ts` (native Messages API) by `format`. Add providers
  here, behind `chat()`.
- `src/runner/` — `run.ts`: scoped `deno run`; `classify.ts`: cage result → ok /
  needs-perms (discovery) / bug; `sandbox.ts`: **OS sandbox tier** that wraps
  the run (bubblewrap on Linux, `sandbox-exec` on macOS) as defense-in-depth
  beneath the Deno floor: denies network + confines writes (so an `--allow-run`
  subprocess, which Deno does NOT bound, is still contained). Pure
  `wrapForSandbox` builds the wrapper argv; `detectSandbox` picks the tier
  (`none` when unavailable — no regression). Applies to both the cage and the
  real run.
- `src/phases/respond.ts` — the single phase entrypoint: converses, calls `read`
  to inspect files, and proposes a script with `write` only when an action is
  needed (read stdin, call the model, emit events); `spawn.ts`, `messages.ts`,
  `ipc.ts` support it. **Streaming:** the phase writes typed **`StreamChunk`
  frames** (NDJSON: `content`/`reasoning`/`marker`; `phases/stream.ts`) to its
  **stderr** as a live display side-channel — `spawn.ts` line-demuxes them to a
  typed `onStream` callback (non-frame lines stay diagnostics), and `agent.ts`
  forwards to the `UI.stream(text, channel)` sink (ACP → `agent_message_chunk`/
  `agent_thought_chunk`, TUI dims reasoning/markers). `<think>` reasoning is
  split out by the provider (`providers/think.ts`) and is **ephemeral** (live
  display only — never logged or re-sent). Its **stdout** stays reserved for the
  structured `{entries}` JSON. The side-channel carries no capability — the
  security boundary is unchanged; exfil-gated run output never streams.

Configuration deep module (`buildContext` is the public interface):

- `src/config/config.ts` — provider presets, instruction load (AGENTS.md,
  CLAUDE.md fallback per scope, prose only), and the **`ConfigLayer` monoid**
  (`mergeLayer`/`composeLayers`/`toLayer`) that roles + flags fold through.
- `src/config/repo.ts` — git-repo detect + per-repo memory (the run's permission
  policy lives in `src/permissions/policy.ts`).
- `src/config/roles.ts` — composable config+instruction bundles (markdown +
  frontmatter): discovery (project shadows global), load, `listRoles`. Folds via
  the `config.ts` monoid; fail-loud on a missing `--role`.
- `src/config/setup.ts` — `parseArgs` (flags via `@cliffy/command`: typed flags,
  generated `--help`/usage, `pagu completions <shell>`) + `buildContext`, the
  thin **assembly**: resolve repo/session/sandbox, then compose `makeRunState` +
  `makeSessionStore` + static fields into the `AgentContext`. Shared by
  frontends.
- `src/config/run-state.ts` — `makeRunState`: the live, role-dependent slice of
  a run as a constructible **value** — folds
  `defaults ⋄ config.json ⋄ roles ⋄
  skills ⋄ flags`, derives
  provider/envelope/concealment/prose/capabilities/ command-entries, loads
  handlers, and owns the runtime mutators
  (`setProvider`/`setRoles`/`setSkills`/`setAdvisor`/`fetchModels` — the TUI's
  `/provider`, `/model`, `/roles`). Extracted from `buildContext`'s closure so a
  run's resolved state is a value, not getters-over-locals (the seam #16/#17
  fold over). Mirrors `makeSessionStore`.
- `src/config/envfile.ts` — opt-in, per-folder-consented `.env` loading (via
  `@std/dotenv`) so keys like `ANTHROPIC_API_KEY` need no manual export.
- `src/config/sessions.ts` — the **session store** (a session = one saved
  conversation thread you reopen): per-project `.pagu/sessions/<id>.log.md` (id
  = immutable ISO timestamp). Log entries are the source of truth; a YAML
  **frontmatter** header holds metadata (optional `name`, `created`) —
  last-modified comes from the filesystem mtime, not stored. Title = `name` ??
  first user message. `buildContext` resolves which session a run uses;
  `AgentContext.switchSession`/`rename` let the TUI change and name sessions
  mid-REPL (mutate the log array in place + repoint persist). (Capability scope
  is a separate concept — see `src/permissions/policy.ts`.)
- `src/config/frontmatter.ts` — shared YAML frontmatter parse/serialize used by
  roles, skills, and sessions.

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
- **Commits:** Conventional Commits (`type(scope): summary`), why-focused body,
  trailer
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
  Remote: private `github.com/phibkro/pagu` (origin/main).

## How to resume, in good spirit

1. Read `CONTEXT.md` (the source of truth) + this file; skim `README.md`.
2. Run the suite; do one live Ollama run to feel the loop.
3. Pick the next slice from **`CONTEXT.md` → Roadmap**. Prefer the lowest-risk
   thing that serves daily usefulness; don't over-build.
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
