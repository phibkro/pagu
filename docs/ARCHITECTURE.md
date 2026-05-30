---
summary: "Where things live — the module-by-module inventory of pagu's codebase (the structural reference)."
tags: [architecture, reference]
---

# pagu — architecture map (where things live)

The module-by-module inventory. Design _rationale_ lives in `CONTEXT.md`; _how
we work_ in `AGENTS.md` + `docs/WORKFLOW.md`. Extracted from `AGENTS.md`
(2026-05-30) to keep that injected-every-turn file lean.

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
  step and runs it through the `loop` combinator below. Siblings seed the log
  differently then run the same loop: `resumeTask`/`submitDecision` (resume a
  deferred proposal, #15) and `scheduledRun({instruction, payload})` (a trigger
  firing, #16 — `seedTrigger` puts the instruction in an authored message and
  the payload in an untrusted `trigger` observation, so a payload can't
  instruct).
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
  (the `pagu vm` launcher pattern), so the orchestrator stays net-less.
  `src/frontends/schedule.ts` — **scheduled-firing frontend**
  (`pagu schedule
  "<instruction>"`, #16): the cron target. One-shot like `cli`
  (net-less, no re-exec) but drives `scheduledRun` (instruction authored, stdin
  payload → an untrusted `trigger` observation) with a _deferring_ approver —
  in-envelope work auto-runs (autonomous tier), the rest queues as pending (HITL
  tier). All frontends differ _only_ in UI + Approver.

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
