# Changelog

All notable changes. Follows
[Conventional Commits](https://www.conventionalcommits.org/). Format: grouped by
release milestone, newest first.

---

## Unreleased (daily use, approaching v1)

### Added

- **VM isolation tier — `pagu vm` launches pagu inside a guest** (sub-project B
  of the test/demo env; `src/vm/` + `src/frontends/vm.ts` + `vm/Containerfile`).
  A coarse OUTER tier wrapping the whole pagu process, mirroring
  `detectSandbox`: `detectVM` picks the runtime (rootless **Podman** first;
  degrades to `none` → runs pagu directly, no regression) and a recursion guard
  (`PAGU_IN_VM`) stops the guest wrapping itself. `pagu vm <task>` resolves the
  model host + concealment on the host, then re-execs pagu in the `pagu:local`
  image with **only cwd mounted** (→ `/work`), **concealed paths masked at the
  mount layer** (`/dev/null`/tmpfs over `.env` etc. — tier-2's read-protection
  replacement, since `bwrap` can't nest in a rootless container), and the model
  reached via the `host.containers.internal` gateway on the **isolated default
  network** (not `--network=host`). Validated live (`nix shell nixpkgs#podman`):
  A's golden scenario stays contained THROUGH the guest — destruction bounded to
  the mount + recoverable, the `.env` canary masked
  (`examples/golden-scenario/
  containment_vm.test.ts`, skips at
  `detectVM === none`). Deferred: Firecracker microVM tier,
  persistent/remote-deploy mode, model-host-only egress confinement
  (Claw-Patrol/Firecracker-shaped). (`feat(vm)`)

- **Golden-scenario containment demo + fixture** (`examples/golden-scenario/`) —
  the adversarial demo fixture (sub-project A of the test/demo environment): a
  throwaway "infra" repo materialized under `$HOME` whose `deploy.log` carries a
  prompt injection, a gitignored `.env` canary, an out-of-repo sentinel, and an
  out-of-envelope backup tarball (`setup.ts`). A `mock_provider.ts` drives pagu
  deterministically with canned-malicious `write` proposals;
  `containment.test.ts` proves the structural guarantees in CI as **three
  focused runs** — exfil (no leak + no egress, contained unattended), escape
  (out-of-envelope write → human gate, bounded), destruction (in-envelope delete
  → auto-runs but bounded + recoverable). `run.ts` / `deno task demo` is the
  live narrative version (real model, PASS/FAIL report). Drives the frozen
  `createContext`/`runTask` API (dogfoods `mod.ts`); skips at sandbox tier
  `none`. The first scored scenario for the future model-compat eval
  (sub-project C).
- **Reasoning tokens + read markers — typed stream channels** — the phase's live
  display side-channel is now typed `StreamChunk` frames (`content`/`reasoning`/
  `marker` NDJSON over stderr; `phases/stream.ts`). A pure `ThinkSplitter`
  (`providers/think.ts`) splits `<think>…</think>` reasoning out of the content
  stream (handling tags split across tokens); reasoning streams live but is
  **ephemeral** — never in `ChatResponse.content`, the log, or the next prompt.
  ACP routes `reasoning`/`marker` → `agent_thought_chunk` and `content` →
  `agent_message_chunk` (per-channel coalescing); the TUI dims
  reasoning/markers. Structured reasoning (`reasoning_content`/Anthropic
  `thinking`) is deferred — both require reasoning re-sent across tool-call
  continuations (else 400), which needs preserve-and-resend + a richer log
  structure. (`feat(acp)`)
- **`/model` lists the provider's models** — `/model` with no args shows the
  provider's available model ids (current marked `*`); `/model refresh`
  re-fetches; `/model <name>` still sets. The list is **fetched in a net-scoped
  subprocess** (`phases/models.ts`, `--allow-net=<provider host>` only) and
  **cached** (cleared on a provider switch) — so the orchestrator stays net-less
  (it never makes the call itself) and repeat `/model` is instant. `fetchModels`
  (OpenAI `GET /models`, Anthropic `GET /v1/models`) added to the provider
  client. (`feat(acp)`)
- **`/roles` + `/skills` over ACP** — both are now shared `SlashCommand`s with a
  **text form** (no-arg lists available + marks active; `<names…>` applies the
  group via `ctx.setRoles`/`setSkills`), so they're advertised and routed over
  ACP like `/provider`/`/model` — closing the "ACP can't switch roles/skills"
  gap. `ctx.availableRoles()`/`availableSkills()` expose the discoverable set
  via the port (no config-internal imports). The TUI keeps its interactive
  picker (it intercepts before delegating). (`feat(acp)`)
- **Stable programmatic API** (`src/mod.ts`) — a single public barrel is the one
  front door for embedding pagu: `runTask` + ports (`AgentContext`/`UI`/
  `Approver`), the loop combinators (`loop`/`andThen`/`pipeline`/`fanOut` +
  `Step`/`Flow`), a new **hermetic `createContext(opts)`** constructor (build a
  context from structured config + your own `UI`/`Approver` + injected handler
  plugins, with no ambient `config.json`/AGENTS.md/`.env` reads), and the
  reference types (`HandlerPlugin`/`Capability`/`Entry`/`ScriptEntry`). The
  capability set stays closed. A **floor test** (`EXPECTED ⊆ deno doc --json`)
  fails CI on any backwards-incompatible change (removal/rename/kind) — the
  v1-compat promise made enforceable. `deno.json` is package-shaped
  (`@phibkro/
  pagu` `0.1.0`); JSR publish + `1.0.0` deferred to the product v1
  milestone. (`feat(api)`)
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
