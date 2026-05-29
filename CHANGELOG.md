# Changelog

All notable changes. Follows
[Conventional Commits](https://www.conventionalcommits.org/). Format: grouped by
release milestone, newest first.

---

## Unreleased (daily use, approaching v1)

### Added

- **Phase-input schema validation** — `readInput()` validates the `PhaseInput`
  contract via a Zod schema (`phaseInputSchema` / `validatePhaseInput`) instead
  of a blind `JSON.parse(...) as PhaseInput`, failing loud (a field-naming
  error) when an orchestrator bug sends a malformed payload across the process
  boundary. Shallow on `log` + complex list fields (the orchestrator is the
  trusted producer; the log codec owns entry shape). Zod is already in the tree
  (transitively via the ACP SDK), so no new attack surface. (`feat(phases)`)
- **Concealment sources — multi-source hide policy**
  (`src/permissions/concealment.ts`) — generalizes gitignore read confinement
  from a single git-derived set into a source-neutral concealment fed by three
  sources: the **VCS source** (`.gitignore`, togglable via `hideGitignored`,
  auto-on in repo mode), an explicit **config `hide`** glob list, and a
  **default-secrets** glob list (`.env`/`*.pem`/`*.key`/… — on by default via
  `hideSecrets`). A **`reveal`** glob list is the bounded escape hatch (lifts
  concealment within `allow`, never widens the envelope). Glob matching is
  gitignore-compatible; the same `Concealment` drives both the agent
  read-refusal and the runner OS-sandbox mask. Config keys
  `hide`/`reveal`/`hideSecrets`/`hideGitignored` + CLI
  `--hide`/`--reveal`/`--no-hide-secrets`/`--no-hide-gitignored`. Now covers
  non-gitignored secrets and applies outside repo mode too.
  (`feat(permissions)`)
- **gitignore read confinement** — the runner masks gitignored paths from its
  OS-sandbox filesystem view, closing the read gap where a script could read a
  secret (`.env`, keys) and surface its contents into the log → model provider.
  bwrap binds `/dev/null`/empty-tmpfs over the path (read returns empty);
  sandbox-exec denies the read (read throws). Applies to both the cage self-test
  and the approved run; tier 1 (no OS sandbox) still has the gap, documented.
  (`feat(runner)`)
- **`fanOut` combinator** (`src/loop.ts`) — the eager-parallel fold of the
  `Flow` monoid, dual to `pipeline`'s lazy-sequential fold; shares the
  `continue` identity. Runs all branches concurrently (`Promise.allSettled`),
  `done` if any is `done`, fail-closed on throw. Race-freedom is a call-site
  responsibility (fan out over read-only carriers). Completes the loop algebra
  ahead of the API freeze. 6 laws property-tested with `pipeline` as the oracle.
  (`feat(loop)`)
- **Config-driven pluggable handlers** — a `before-approve` injection slot in
  the skill/task/command pipelines. Handlers are TS modules (`name`,
  `description`, `permissions[]`, default `Step<ReadonlyExec>`); declared in
  `config.json` or role frontmatter under `handlers.before-approve`. Hybrid
  execution: empty/orchestrator permissions run in-process (no cold start);
  extra permissions (e.g. `allow-net`) run in an isolated `phases/handler.ts`
  subprocess with exactly the declared ceiling. TUI shows active handlers +
  execution mode. (`feat(handlers)`)
- **`ReadonlyExec` — gate-never-widen layer 2** — terminal handlers typed
  `Step<ReadonlyExec>`; the compiler forbids replacing `body`/`perms`.
  (`feat(types)`)
- **Sandbox tier in result log entries** — `ResultEntry.sandbox` records which
  OS sandbox ran each script; macOS `sandbox-exec` verified on real hardware.
  (`feat(log)`)
- **Live runner stdout streaming** — scripts now show output line-by-line in TUI
  and ACP as the process runs, not only at exit. CLI stays batch.
  (`feat(stream)`)
- **Cooperative cancellation** — Ctrl-C in TUI and `session/cancel` in ACP kill
  the in-flight respond subprocess via `AbortSignal` instead of the whole
  process or no-opping. `· cancelled` message on clean abort. (`feat(cancel)`)
- **Architecture layer checker** in CI — `scripts/check-layers.ts` enforces
  hexagonal architecture boundaries and verifies `// pure:` header claims. R1
  core isolation, R2 loop purity, R3 respond-no-exec (invariant #1), R4
  pure-claim verified. (`feat(ci)`)
- **Mermaid diagrams** — `docs/diagrams/pipeline-shapes.md` (string diagram of
  the four handler pipelines) and `docs/diagrams/capability-lifecycle.md`
  (sequence diagram of one capability invocation end-to-end). (`docs(diagrams)`)
- **Capability registry** (`src/capability/registry.ts`) — `Capability<Data>`
  interface; four capability objects (`writeCapability`, `skillCapability`,
  `runCommandCapability`, `runTaskCapability`) using
  `satisfies Capability<Data>` to preserve literal `entryKind` types; `as const`
  registry array with derived `ActionEntry`/`isActionEntry`. `agent.ts` dispatch
  collapses from 3 branches to a registry `find`; `respond.ts` if-chain
  collapses to a `capData` loop. Adding a new capability = one `satisfies`
  declaration + one line. (`feat(capability)`)
- **Readonly envelope types** — `PermissionSet = readonly Permission[]`,
  `Envelope.allow/deny` readonly properties, `AgentContext.envelope` readonly.
  Prevents any code from accidentally widening the session envelope.
  Gate-never-widen layer 1. (`feat(permissions)`)
- **Grammar enum value type** — `{ enum: string[] }` value type in
  `grammar.ts`/`validateValue`. Unlocks `git log --format=<oneline|short|full>`
  style rules. (`feat(grammar)`)
- **Shared capability execution substrate** (`src/capability/index.ts`) —
  `cageOnce`, `cageWithinCeiling`, `performRun`, `autoApprove`, `run`. All three
  capability executors (skill/task/command) refactored to
  `pipeline([...gates, autoApprove, run])`. Net-gate and result-emission
  centralized. (`refactor(capability)`)
- **ACP tool-call surfacing** — script/skill-invoke/command-invoke entries
  surface as `tool_call` + result as `tool_call_update` in Zed and other ACP
  editors. Live and on session reload. (`feat(acp)`)
- **ACP config slash commands** — `/model`, `/provider`, `/advisor` advertised
  and routed over ACP. (`feat(acp)`)
- **ACP history replay** — reopening a session replays the conversation into the
  editor so the thread isn't empty. (`feat(acp)`)
- **`run_command` tool** — agent can run vetted read-only commands (`rg`,
  `git log`, `git diff`) with validated free args (LangSec safe-argv grammar).
  Auto-approved within a fixed read-only ceiling; no write, no net.
  (`feat(tasks)`)
- **Command grammar** (`src/tasks/grammar.ts`) — formal `CommandRule`
  recogniser; `recognize` subsumes `matchesPolicy`; flag canonicalization (no
  prefix abbreviation, no bundling); path containment via `within`.
  (`feat(tasks)`)
- **Default read-only command rules** — `rg`/`git log`/`git diff`/`git show`
  wired out of the box with grammar + availability filter (legal ∩ installed).
  (`feat(tasks)`)
- **Availability filter** — `run_command` advertises only rules whose program is
  on PATH. (`feat(tasks)`)
- **Composable agent-loop substrate** (`src/loop.ts`) — `Step<C>`, `loop`,
  `andThen`, `pipeline`. `runTask` is `loop(turn, MAX_TURNS)(ctx)`.
  (`feat(loop)`)
- **Composable handler pipeline** — `write/execute.ts` is
  `pipeline([cage, approve, run])` over `Step<Proposal>`. (`feat(write)`)
- **ACP frontend** — `pagu --acp` runs as an ACP agent over JSON-RPC/stdio;
  editors (Zed via `agent_servers`) drive it. (`feat(acp)`)

### Fixed

- **Log codec fence collision** — `~~~` body line truncated the event store;
  fixed with variable-length fences (CommonMark-style). Found by a property
  test. (`fix(log)`)
- **Prompt affordance reframe** — model told its affordances ("write runs with
  real effect"), not the cage; fixed small-model under-claiming.
  (`fix(respond)`)
- **gitignored read-protection** — `handleRead` refuses paths listed by
  `git ls-files --ignored`. (`fix(CF3)`)
- **`invoke_skill` re-reads scripts from disk at invocation** — auto-approval is
  "what's on disk now", not the startup snapshot. (`fix(skills)`)
- Various ACP fixes: cwd detection, token coalescing, /provider output.

---

## Prior milestones (all on main, no version tags yet)

### Roles + Skills + Task policy

- Composable role bundles (markdown frontmatter + prose) with
  project-shadows-global scoping and `--role` flag.
- TUI `/roles` interactive picker; runtime `/provider`, `/model`, `/advisor`.
- Skill system (`src/skills/`) — `SKILL.md` + `scripts/` subdir; `invoke_skill`
  auto-approves within declared permission ceiling.
- `run_task` tool — deny-by-default command policy; cage-inferred permissions
  written to `.pagu/inferred-perms.json` (the permission type cache).
- Optional advisory reviewer (`src/write/advisor.ts`) — pre-approval model call,
  structured `[advisory]` flags, fails open.
- Structured review aid at the approval gate — risk tier badge, permission diff,
  LCS iteration diff, `--allow-run` target check.

### Session management

- Per-project conversation store (`.pagu/sessions/<id>.log.md`).
- TUI commands: `/sessions`, `/new`, `/open`, `/fork`, `/rename`, `/history`,
  `/clear`.
- `--continue` flag; `--list-sessions`.
- Session names via YAML frontmatter.

### Providers + OS sandbox

- OpenAI Chat Completions client (covers Ollama/OpenRouter/OpenAI/Groq/…).
- Native Anthropic Messages API client.
- SSE token streaming + live stderr side-channel.
- OS sandbox tier: bubblewrap (Linux) + sandbox-exec (macOS) wrapping every
  cage + runner run.

### Shell ergonomics

- `@cliffy/command` flag parsing with `--help` and `pagu completions <shell>`.
- TUI ghost-text autocomplete for slash commands.
- TUI interactive pickers for `/roles` and `/open` (arrow-key,
  `@cliffy/keypress`).
- `.env` loading via `@std/dotenv`.

---

## Known limitations (v1 scope)

- **gitignore read gap at tier 1** — on a platform with no OS sandbox (Windows,
  `--no-sandbox`), `.gitignore` denies are write-only (`--deny-read=<child>`
  breaks `readDir` of the parent), so a broad-read script can surface secret
  file contents to the (local) model. Closed at tier 2 (bwrap/sandbox-exec
  masking); persists only where tier 2 is unavailable.
- **macOS `sandbox-exec`** — implemented and wired but not exercised on real Mac
  hardware. The Deno permission floor (tier 1) always applies; tier 2 may
  silently degrade to `none` if the profile is wrong.
- **Windows** — no OS-level isolation layer. Deno permissions (tier 1) are the
  only boundary.
- **ACP — partial** — `/roles` and `/skills` still require TUI pickers (no ACP
  text-listing equivalent yet).
