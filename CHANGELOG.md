---
summary: "Historical log of what shipped (pre-v1, by feature). The forward plan is ROADMAP.md; durable design is CONTEXT.md."
tags: [changelog, history]
---

# pagu — changelog

What has shipped — kept out of `ROADMAP.md` so the forward plan stays
forward-only (the lifecycle "history" tier; see `docs/WORKFLOW.md`). Pre-v1 and
unversioned: entries are by feature, roughly in shipping order. The
Conventional-Commit log is the dated, authoritative record; this is the
human-readable digest. Extracted from `ROADMAP.md` (2026-05-30).

## Shipped since the original draft

- **Gate v1 request/adjudication MVP** — the in-sandbox `fileRequest` SDK sends
  one strict request over a bind-mounted Unix socket and awaits its tied
  decision; the outside `pagu gate` daemon applies refuse/auto/operator tiers,
  projects once/session grants across restarts, persists only to user policy,
  and appends request/decision/grant evidence. The request protocol exposes no
  resolution operation. Relaunch/resume is intentionally deferred.

- **The chat-or-act loop** — a single `respond` phase that converses and only
  authors a script when an effect is needed (replaced separate Observe/Author).
- **Permission discovery via the cage** — the self-test runs with no net and
  scratch-only writes, collecting the permissions Deno _denies_ as the requested
  set, surfaced at approval and fed to `within()`
  (`src/permissions/envelope.ts`) to gate auto-approve. Static AST analysis
  remains an optional precision refinement, not required.
- **Approval** — y/n per-script gate; **repo-mode** auto-approve within the
  git-repo envelope.
- **Conversation sessions** — per-project `.pagu/sessions/<id>.log.md` store
  with list / new / open / **fork** / rename (frontmatter `name`), `--continue`.
- **OS sandbox tier** — bubblewrap (Linux) + sandbox-exec (macOS): denies
  network and confines writes beneath the Deno floor (`src/runner/sandbox.ts`).
- **Providers** — OpenAI Chat Completions (default; Ollama/OpenRouter/OpenAI/…)
  - native Anthropic.
- **Frontends** — CLI one-shot + streaming TUI (spinner, slash commands with
  ghost-text autocomplete, context readout).
- **CLI ergonomics** — flags parsed by `@cliffy/command`: a generated
  `pagu --help`, and `pagu completions <bash|zsh|fish>` for shell completion.
- **Interactive pickers** — `/roles` (multi-select) and `/open` (single-select)
  open an arrow-key list (`src/frontends/select.ts`); the selection model is
  pure and unit-tested, key decoding is borrowed from `@cliffy/keypress`. Both
  keep a text fallback when stdin is not a TTY.
- **Config interop** — reads `CLAUDE.md` as a per-scope fallback when
  `AGENTS.md` is absent (prose only, never `.claude/` settings).
- **Roles** — composable config+instruction bundles: a markdown file whose YAML
  frontmatter folds as a `ConfigLayer` monoid and whose body appends as prose.
  `--role <name>` (repeatable) and the TUI `/roles` picker. See _Roles — decided
  behavior_ below.
- **Structured review aid** (`src/write/review.ts`) — pure module with four
  static analyses at the human approval gate: risk tier badge (read-only /
  local-write / EXTERNAL-NET), permission diff against envelope, LCS-based
  iteration diff when cage revised the script, and `--allow-run` target check.
  Replaces the flat script+perms dump.
- **Deno denial format pin** — two integration tests in `classify.test.ts` that
  run real Deno subprocesses and assert `classifyRun` returns `needs-perms` with
  the exact path. Fails at CI if Deno changes its denial message wording.
- **Advisory reviewer** (`src/write/advisor.ts`) — optional pre-approval add-on.
  Sends `{task, script, perms}` (not the full log) to a configurable model,
  returns structured flag strings labeled `[advisory]`. Fails open on any error.
  Enabled via `--advisor` flag, `advisor: true` in config, or TUI `/advisor`
  command (toggle/configure with preset + model; tab-completes). Separate
  `advisorProvider`/`advisorModel` config fields allow a different model from
  the proposer.
- **Illegal state elimination** — three redundant derived fields removed:
  `autoEnabled` (was `!!repo`), `autoReturn` (was `!grantsNet(ranWith)`), and
  scoped `Permission { flag: "all" }` (now a discriminated union; `all` is never
  scoped). `advisorEnabled` also removed — `advisorConfig` presence is the
  signal.
- **Skills system** (`src/skills/skill.ts`, `src/skills/tool.ts`) — a skill is a
  directory `.pagu/skills/<name>/` containing `SKILL.md` (frontmatter +
  instructions, agentskills.io spec) and a `scripts/` subdirectory with
  pre-authored `.ts` files. Denotation: `(prose, ConfigLayer, files, scripts)` —
  extends roles by the same composition law. `invoke_skill` tool: agent names a
  skill script by enum-constrained name; the orchestrator resolves the verbatim
  body from `ctx.activeSkillScripts` (agent never copies content); cage
  validates and auto-approves within the declared permission ceiling.
- **Command policy / `run_task`** (`src/tasks/policy.ts`,
  `src/tasks/discovery.ts`, `src/tasks/tool.ts`) — `run_task` tool: agent passes
  an exact command string (enum-constrained to the allowed-tasks policy). Deny
  by default: only tasks listed in `allowed-tasks` config can run via
  `run_task`. Discovery scans `deno.json`, `package.json`, `Justfile` for
  available tasks at startup. **Type-inference model for permissions:** first
  cage run with minimal perms discovers what the command actually needs → stored
  in `.pagu/inferred-perms.json` (gitignored lockfile); second run cages against
  the stored ceiling. Explicit annotation = declared permissions; inferred type
  = cage-discovered permissions; strict mode = outside-repo (explicit required);
  type cache = `inferred-perms.json`.
- **ACP frontend** (`src/frontends/acp.ts`) — pagu runs as an Agent Client
  Protocol agent over stdio (`pagu --acp`), so editors (Zed via `agent_servers`)
  drive it. pagu is the _agent_, editor is the _client_, launched as a local
  subprocess. Port mapping: `session/prompt` → `runTask`; `session/update` ←
  `UI` (show/stream → `agent_message_chunk`); `session/request_permission` ←
  `Approver`; `session/new`/`session/load` ↔ session store. Uses
  `@agentclientprotocol/sdk` (`AgentSideConnection`, ndJSON over Deno-native web
  streams). **Declines the client's `terminal/*`/`fs/write` for execution** —
  the runner stays the only exec path (invariant #1); ACP carries conversation +
  approval UX only. `session/new`|`load` honor the client's workspace `cwd`
  (2026-05-28) so repo + read-allowlist detection follows the editor's project.
  **v1 is partial** — chat + approval + **history replay on load** + **config
  slash commands** (`/model`/`/provider`/`/advisor` advertised + routed;
  `src/commands.ts`) work. Cancellation and tool-call surfacing remain (see Open
  → "ACP — remaining integration work"). Still deferred: images/audio, MCP,
  remote transport.
- **Composable agent loops — substrate (v1)** (`src/loop.ts`) — the agent loop
  is now a composable value, not a hand-written `for`. Denotation:
  `⟦Flow⟧ =
  continue | done` (coproduct), `⟦Step<C>⟧ = C → Promise<Flow>` (a
  turn), `⟦loop⟧ =
  bounded fixpoint`. `loop : Step → Step` is closed over the
  type (a loop is itself a composable turn) — the lawful reason it returns a
  `Step`, not a runner. `runTask` is reconstructed as
  `loop(turn, MAX_TURNS)(ctx)`, behavior-identical (full suite + live run
  green). The turn is **atomic over the inner cage fix-round loop** (unification
  deferred). `andThen` (composition) is now **implemented** (the handler
  pipeline below is its first caller, at the `Proposal` carrier); `fanOut` (the
  eager-parallel fold of the `Flow` monoid, dual to `pipeline`'s lazy-sequential
  fold) remains deferred — see
  `docs/specs/2026-05-29-fanout-combinator-design.md`. See also
  `docs/specs/2026-05-28-composable-agent-loops-design.md`.
- **Composable handler pipeline (v1)** (`src/write/pipeline.ts`) —
  `write/execute.ts` is now `pipeline([cage, approve, run])` over
  `Step<Proposal>`: the proposal–handler model made concrete (`docs/CONCEPTS.md`
  — effects ≅ permissions ≅ types). Each stage is a named, insertable handler; a
  **gate** halts (returns `done`). Reuses the loop substrate's generic `Step<C>`
  and implements `andThen` + `pipeline` in `src/loop.ts`. Behavior-identical
  (full suite + a live run on both the auto-approve→run and reject→short-circuit
  paths). Keystone law: **handlers tighten, never widen** (a future plugin is
  safe by the same lattice law as role composition; the set of handlers is the
  TCB). Deferred: config-driven pluggability (where the law gets type-enforced)
  and generalizing to the `skills`/`tasks` executors. See
  `docs/specs/2026-05-28-composable-handler-pipeline-design.md`.
- **Per-project `.pagu/config.json`** (`src/config/project-config.ts`, wired in
  `src/config/setup.ts`) — an auto-loaded repo base config, folded after global
  `config.json` and before the opt-in bundles + flags. Because it loads just by
  opening the repo it is untrusted input (#3): a pure `sanitizeProjectLayer`
  runs before the fold (an **allowlist**, default-deny): outside consented repo
  mode only `model`/`maxTokens`/`hide` survive; egress (`provider`/`baseURL`/…),
  grants (`allow`/`write`/`allowedTasks`), and concealment-weakening
  (`reveal`/`hideSecrets`/…) are gated; `handlers` (code paths) always stripped.
  Keystone law: **a project config can't redirect egress, self-grant, weaken
  concealment, or load code** (`[law: sanitize project layer]`, property-tested:
  `untrusted ⇒ only UNTRUSTED_SAFE`). See
  `docs/decisions/0003-per-project-config.md`.
