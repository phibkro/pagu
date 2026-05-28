# pagu — context & design

> Status: the v1 loop is implemented and in daily use. Command: `pagu`. Named
> for _Paguroidea_, the hermit-crab superfamily — soft and untrusted inside (the
> LLM), operating only through a hard, borrowed, disposable shell (the sandboxed
> runner).
>
> **This is the single source of truth for the project** — rationale, threat
> model, design, roadmap, and the idea backlog. Durable project context goes
> here, not scattered across docs. **`README.md`** is usage; **`AGENTS.md`** is
> how-we-work; **`docs/CONCEPTS.md`** is the mental-models reference. The
> **Roadmap** at the bottom tracks shipped / open / backlog.

**Map** (sections below): _What & why_ — One-liner · Why it exists ·
Goals/non-goals. _The model_ — Core principle · System map · Phase FSM · State
model. _Security_ — Approval model · Output gating · Security tiers · Threat
model. _Project_ — Tech & UX · Build & packaging · **Roadmap** (Shipped · Roles
decided-behavior · Open · Idea backlog, with the **Next up** pointer).

## One-liner

A local, cross-platform agent you use like a terminal — but the model **can
never execute anything**. It reads context and _authors_ scripts into an
auditable conversation log; a human approves; a separate sandboxed runner
executes. Capability-phased, event-sourced, BYO model.

## Why it exists

Existing computer-use/coding agents make `execute` a tool the model can call
(behind an approval prompt). pagu removes that capability entirely: security
comes from the **absence** of the tool plus a mandatory human gate, not from
gating a dangerous tool the agent holds. The result is an agent whose entire
blast radius is statically enumerable.

## Goals / non-goals

**Goals**

- Quick to install on any computer/laptop/appliance. Connect a model provider,
  use immediately.
- Maximal power for user _and_ agent — with **no compromise of security for
  utility** (security is the invariant; utility is maximized within it).
- Fully auditable: every observation, proposed script, and result is a durable,
  diffable event.
- Small trusted core — readable in one sitting.

**Non-goals (deferred)**

- GUI/computer-use (mouse/screen) — CLI + TUI first, expand only if needed.
- Uniform OS-level sandboxing across every platform (see Security tiers — Linux
  and macOS are done; Windows is open).

(Several original non-goals have since shipped: conversation **forking**
(`/fork`), and a **multi-provider** layer — OpenAI Chat Completions covers
Ollama/OpenRouter/OpenAI/etc., with native Anthropic alongside.)

## Core principle: the model has no _real-effect_ execute capability

The agent's tools are **read** (allowlisted inspect), **write** (arbitrary
script proposals — requires human approval), **invoke_skill** (pre-authored
skill scripts — auto-approved within declared ceiling), and **run_task** (named
project tasks from the command policy — auto-approved within inferred/declared
ceiling). There is no `bash`/exec tool. **Real-effect execution** — running a
script with real-path writes, network, or broader permissions — happens only in
a separate process triggered by **human approval** or a pre-vetted envelope.

### The capability ladder

| tool           | what it does                                                             | approval path                                    |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| `read`         | inspect files/dirs                                                       | no side effects — always allowed                 |
| `write`        | author arbitrary scripts                                                 | **human gate** (y/n at every proposal)           |
| `invoke_skill` | run a pre-authored skill script verbatim                                 | auto-approved (verbatim match + ceiling)         |
| `run_task`     | run a named project task from policy                                     | auto-approved (policy match + ceiling)           |
| `run_command`  | run a vetted read-only command (search/inspect) with validated free args | auto-approved (grammar match, read-only ceiling) |

`invoke_skill`, `run_task`, and `run_command` expand the agent's effective
capability without widening the blast radius: the orchestrator verifies the
script body matches verbatim what was pre-approved, the cage validates
permissions within the declared or inferred ceiling, and `run_command`'s args
are validated against a per-command **grammar** (the safe argv sublanguage) and
run with a fixed read-only ceiling (no write/net). `run_task` and `run_command`
are two presentations over one command-policy spine (`recognize` subsumes
`matchesPolicy`; exact match = the degenerate zero-free-arg grammar).

Refinement (the cage): the agent _may_ run its proposed script in a **disposable
cage** to self-test and self-correct before you see it. The cage grants
`--allow-read=<allowlist>` + `--allow-write=<scratch>` only — **no network, no
real-path writes** — so autonomous execution cannot exfiltrate or damage
anything. The cage classifies each run:

- **runtime/type error** → feed back to the agent; it fixes and retries
  (bounded), so you review a _working_ script, not a buggy one;
- **permission denial** → not a bug — the script asked for a real permission the
  cage withholds; this _is_ the permission-discovery mechanism (see below),
  surfaced to you at approval;
- **clean exit** → present as-is.

So the boundary is precise: autonomous execution is confined to a no-net,
no-real-write rehearsal; real-effect execution stays human-gated.

## System map

Who holds which capability. The agent process (`respond`) only ever has read +
net-to-the-model; **write and run live only in the human-gated runner**, itself
wrapped by the OS sandbox where available.

```mermaid
flowchart TD
  human["Human"]
  model["LLM provider"]
  subgraph machine["your machine"]
    orch["orchestrator · CLI / TUI<br/>(holds run + read + write)"]
    respond["respond phase<br/>--allow-net=model, --allow-read=allowlist<br/>never write or run"]
    subgraph sandbox["OS sandbox · bwrap / sandbox-exec"]
      runner["runner<br/>deno run --no-prompt &lt;approved flags&gt;"]
    end
    fs[("files")]
  end
  human -->|"task / approve (y/n)"| orch
  orch -->|"spawn: read + net-to-model only"| respond
  respond <-->|"tokens + read / write tool calls"| model
  respond -->|"chat reply OR proposed script"| orch
  orch -->|"run — only after approval"| runner
  runner -->|"writes confined to granted paths"| fs
```

## Phase FSM (chat-or-act)

The loop is a small state machine. **Each turn is a separate, short-lived
process launched with exactly that turn's permissions** — so the runtime
sandbox, not just our code, enforces the boundary. Turns are stateless: each
folds the conversation log and appends new events.

The original Observe and Author phases are now a **single `respond` phase**: the
model converses normally and only switches into "act" mode — authoring a script
with the `write` tool — when finishing the task genuinely needs an effect. It
reads with the `read` tool inside the same phase. So a plain question costs one
read-capable turn and no script at all.

| Phase                | process permissions                                 | tools                                       | advances when                        |
| -------------------- | --------------------------------------------------- | ------------------------------------------- | ------------------------------------ |
| **Respond**          | read = allowlist; net = provider only               | `read`, `write`, `invoke_skill`, `run_task` | model replies (chat) or emits action |
| **Cage** (self-test) | read = allowlist; write = scratch; **no net**       | — (runner)                                  | proposal runs clean / needs-perms    |
| **Review**           | _(no agent process)_                                | —                                           | **human** y/n (or auto-approve rule) |
| **Run**              | runner: scoped perms, in OS sandbox where available | — (runner)                                  | script exits → result re-enters loop |

The agent process only ever holds read + net-to-model; it never holds write or
run. After a run, the result re-enters the log and the loop continues (the model
wraps up or proposes the next step), bounded by a turn limit.

The three action paths diverge at the Respond→Cage transition:

| Tool called    | Cage purpose              | Auto-approve rule                        | Fix loop?                                     |
| -------------- | ------------------------- | ---------------------------------------- | --------------------------------------------- |
| `write`        | Discover needed perms     | Envelope / skill-match / human y/n       | Yes (MAX_FIX=3) — model repairs buggy scripts |
| `invoke_skill` | Validate within ceiling   | Ceiling match — auto only, no human gate | No — pre-authored, bug = reject               |
| `run_task`     | Discover / verify ceiling | Ceiling match — auto only, no human gate | No — generated body, bug = reject             |

```mermaid
stateDiagram-v2
  [*] --> Respond: user message

  Respond --> [*]: chat reply (no action)
  Respond --> SkillCage: invoke_skill(name)
  Respond --> CommandCage: run_task(cmd)
  Respond --> ScriptCage: write(body)

  SkillCage --> SkillRun: ok / perms within ceiling
  SkillCage --> [*]: ceiling exceeded or cage bug (reject)

  CommandCage --> CommandRun: ok / perms within ceiling
  CommandCage --> [*]: ceiling exceeded or cage bug (reject)
  CommandCage --> Respond: not in policy (feed back, retry)

  ScriptCage --> ScriptCage: bug → fix round (model repairs, bounded)
  ScriptCage --> Review: ok / perms discovered

  Review --> [*]: rejected
  Review --> ScriptRun: auto-approved (envelope / skill match) or human y

  SkillRun --> Respond: no net — result loops back
  CommandRun --> Respond: no net — result loops back
  ScriptRun --> Respond: no net — result loops back

  SkillRun --> [*]: net granted — output not auto-returned
  CommandRun --> [*]: net granted — output not auto-returned
  ScriptRun --> [*]: net granted — output not auto-returned
```

**On phases as a folder:** `phases/` (the respond subprocess infrastructure) and
`runner/` (the cage + run execution engine) are both named after phases in the
FSM, but they don't co-change — the respond phase subprocess and the runner are
independent mechanisms. The coupling test: if you add a new tool, you change
`phases/respond.ts` (add dispatch) and the relevant capability module
(`skills/`, `tasks/`, `write/`) — you don't change `runner/`. The FSM is the
mental model; the folder structure reflects coupling.

## State model: the conversation log _is_ the event store

There is one canonical artifact: an append-only, git-backed conversation log.
Observations, proposed scripts, approvals, and run results are first-class turns
woven into it (CQRS event stream). Desktop state is the projection (fold) over
those events. Git history gives audit + (later) forking = branching the log.

### Format: Markdown + structured fenced blocks

Human-diffable prose with typed, parseable fenced blocks. **Tilde** fences
(`~~~pagu:<kind>`), not backtick, so a script body containing ``` survives the
round-trip:

- `~~~pagu:message` — a conversational turn (user task or assistant prose).
- `~~~pagu:observation` — what a read returned. `source` records **the command
  that ran** (`read <path>` / `ls <path>`) for a full action audit, not just its
  output.
- `~~~pagu:script` — a proposed script (lang + body).
- `~~~pagu:decision` — human approve/reject + rationale.
- `~~~pagu:result` — runner output + exit status + the exact perms it ran with.

One file, readable by a human, parseable by the harness, clean git diffs. A
session also carries a small YAML **frontmatter** header (display `name`,
`created`); the entries below stay the source of truth (`src/conversations.ts`).

## Approval model

> **Implemented:** a simple **y/n** per-script gate is the default — the human
> sees the proposed script and the exact permissions it will run with (surfaced
> by the cage's discovery), and approves or rejects. The runner enforces exactly
> those permissions; its enforcement is the actual security boundary.

- **Per-script explicit by default** (y/n; the perms list is always shown).
- **Auto-approve within an envelope.** A proposal runs without a prompt only
  when its **discovered permission set ⊆ a pre-vetted envelope**, verified by
  the cage (Deno's own denials), never by trusting the agent's description — so
  auto-approve can never silently widen the real capability surface. **Repo
  mode** is the shipped instance: grant read+write to the current git repo and
  auto-approve scripts confined to it (git is the undo buffer, the runner has no
  net, `.gitignore`'d paths are write-denied). Remembered per repo.
- **Modes** = named bundles of such envelopes — generalizing repo mode (e.g. a
  `scratch-readonly` mode) — remain open.

## Output gating falls out of the runner's permissions

Whether a script's output auto-returns into the agent's context is a function of
how the runner ran it:

- Runner had **no network** (`--deny-net` / no `--allow-net`) → output could not
  have phoned home; auto-return is contained. Script review covers local exfil
  (e.g. "logs out `$SECRET`").
- Runner was **granted network** → output passes a human glance before
  re-entering context.

This is the one deliberately relaxed point: the audit of the _script_ (catching
env-var logging etc.) is what makes the output channel safe, so we don't
double-gate output for net-less runs.

## Security tiers (portability makes this two-layer)

1. **Portable floor — Deno permissions.** Cross-platform read/write/net/ run
   scoping, identical on Linux/macOS/Windows. This is always present. Also
   applied to the **harness's own phase processes** (a buggy harness in Author
   phase still cannot read the disk).
2. **OS isolation — platform-specific hardening (implemented for Linux/macOS).**
   The runner wraps each `deno run` in **bubblewrap** (Linux, when `bwrap` is on
   PATH) or **sandbox-exec** (macOS). v1 hardens the two escape vectors that
   matter: it **denies network** (unless granted) and **confines writes** to the
   granted paths + scratch. Crucially this contains a subprocess spawned via
   `--allow-run` — which Deno does _not_ permission-bound — at the kernel level.
   It wraps both the cage self-test (unreviewed code) and the approved run.
   Auto-detected; falls back to tier 1 with a note when unavailable
   (`src/runner/sandbox.ts`). Windows (AppContainer/Job Objects) is open.

   _Scope of v1:_ **reads stay broad** at the OS layer (Deno still bounds the
   script's own reads). OS-layer read isolation + Landlock are roadmap items.

Honest ceiling: with only tier 1, a Deno/V8 escape would breach isolation; tier
2 closes the write/network escape (incl. via subprocesses) where the OS supports
it. Read confinement of subprocesses is the remaining tier-2 gap.

```mermaid
flowchart TD
  subgraph tier2["Tier 2 · OS sandbox — bwrap / sandbox-exec (Linux/macOS)<br/>denies network · confines writes · contains --allow-run subprocesses"]
    subgraph tier1["Tier 1 · Deno permissions — always on, portable<br/>--allow-read / write / net / run, exactly scoped"]
      script["approved script"]
    end
  end
```

The script sits inside both walls; on a platform without tier 2 it still has the
portable tier-1 floor around it (no regression).

## Threat model (load-bearing parts)

- **Boundary = no-exec-capability + mandatory per-proposal human review.**
- **Reads are untrusted input** — the prompt-injection / exfiltration surface.
  Adversarial content in read material can steer what the agent _proposes_; the
  human review of every proposal is the backstop (Dual-LLM / quarantine
  posture). The per-turn gate bounds the read → propose → run → read
  amplification.
- **Runner perms cap an approved-but-buggy script**; **harness phase perms cap a
  buggy/compromised harness**.
- **Advisory reviewer** (`src/advisor.ts`) is a pre-screening _control action_
  that enriches human information at review — not a second approver and not in
  the critical path. It fails open; the human gate remains the sole security
  boundary. Structured `[advisory]` flags are presented alongside the review aid
  output to assist the human reviewer, not to make approval decisions
  autonomously.
- When approved scripts need egress, a credential-injecting proxy (e.g. Claw
  Patrol) can mediate so the script never sees raw secrets.

## Tech & UX

- **Runtime:** Deno (TypeScript). Cross-platform, runs TS directly,
  `deno compile` → single binary, permission model is the security floor.
- **Core in plain TypeScript — no Effect (evaluated, declined 2026-05).** A
  throwaway spike confirmed Effect v4-beta (`effect@4.0.0-beta.71` plus
  `@effect/ai-anthropic`/`-openai@4.0.0-beta.71`) _does_ run under Deno: the
  runtime, `effect/unstable/ai`, and `Tool`/`Toolkit`/handlers all compose and
  type-check. Declined anyway on measured cost — the AI layer is
  `effect/unstable/ai` (an explicitly _unstable_ API on a _beta_ runtime, with
  docs still v3-shaped); the `effect` package unpacks to ~48 MB over a wide
  transitive graph; and importing the AI modules adds ~120 ms to a cold process,
  which matters because pagu spawns a **fresh process per turn**. All of that
  works _against_ the value prop (small TCB, auditable in one sitting, minimal
  supply chain), and Effect's strength (in-process structured concurrency)
  doesn't touch pagu's real security seam (separate processes plus Deno
  permissions). **Direction:** build our own minimal abstractions in Effect's
  _footsteps_ — typed errors, composable layers, explicit effects at the seams —
  without the runtime. Revisit only if `effect/ai` stabilizes out of `unstable/`
  _and_ orchestration pain justifies it; even then, keep it out of the
  security-critical core.
- **`@cliffy/keypress` + `@cliffy/command` (adopted 2026-05).** Terminal key
  parsing (SS3 arrows, modifiers) is fiddly, edge-case-heavy, and
  non-differentiating, so we borrow the focused, stable `@cliffy/keypress` (1.x,
  small @std-based dep) for it — the opposite profile to the rejected Effect
  (small/stable/focused, earns its weight, like our `@std/*` use). We do **not**
  use `@cliffy/prompt`'s Select/Checkbox despite the overlap: they call
  `exit(130)` on Ctrl-C, which would kill the whole REPL. Driving keypress at
  the event level lets Ctrl-C/Esc cancel just the picker; the pure selection
  model (`reduce`/`frame`) stays ours and stays tested. Likewise `parseArgs`
  uses `@cliffy/command` for the CLI surface: typed flags, generated
  `--help`/usage, and shell completions as the flag set grows. Flags still map
  onto the same `RunOpts`/`ConfigLayer` split (reversible), and an unknown
  `--flag` falls into the free-text task — matching the prior hand-rolled
  behavior and harmless under the no-exec invariant.
- **Provider:** a hand-rolled **OpenAI Chat Completions** client is the default
  wire format (covers Ollama — the local default — plus OpenRouter, OpenAI,
  Groq, LM Studio, vLLM…), with a native **Anthropic** Messages client
  alongside, selected by a per-preset `format`. BYO key via named env vars;
  config never holds secrets. (Anthropic subscription OAuth is barred — API key
  only.)
- **Harness:** our own minimal loop + phase FSM, written from scratch — inspired
  by Pi (loop shape, tool-call parsing), not forked. Smaller TCB is the point,
  and from-scratch bakes in the no-exec/phase model from line one. `pi-ai` kept
  as an optional fallback if multi-provider lands.
- **Runner shell-out:** generated scripts use **only Deno built-ins** (no
  imports — simplest to run offline and review); they call CLIs via
  `Deno.Command`, gated by `--allow-run=<specific binaries>` surfaced by the
  cage. (A `dax`-style helper could be allowed later if the no-import rule
  proves too restrictive.)
- **UX:** CLI-first ("terminal with an LLM"); TUI for the transcript + approval
  view; GUI only if a real need appears.

## Build & packaging

- Standalone git repo (dev checkout lives in a gitignored subfolder of the
  homelab repo; published separately, e.g. JSR `@.../pagu`).
- No build step (Deno runs TS); distribute via `deno install` / `deno compile`.

## Roadmap

### Shipped since the original draft

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
  open an arrow-key list (`src/select.ts`); the selection model is pure and
  unit-tested, key decoding is borrowed from `@cliffy/keypress`. Both keep a
  text fallback when stdin is not a TTY.
- **Config interop** — reads `CLAUDE.md` as a per-scope fallback when
  `AGENTS.md` is absent (prose only, never `.claude/` settings).
- **Roles** — composable config+instruction bundles: a markdown file whose YAML
  frontmatter folds as a `ConfigLayer` monoid and whose body appends as prose.
  `--role <name>` (repeatable) and the TUI `/roles` picker. See _Roles — decided
  behavior_ below.
- **Structured review aid** (`src/review.ts`) — pure module with four static
  analyses at the human approval gate: risk tier badge (read-only / local-write
  / EXTERNAL-NET), permission diff against envelope, LCS-based iteration diff
  when cage revised the script, and `--allow-run` target check. Replaces the
  flat script+perms dump.
- **Deno denial format pin** — two integration tests in `classify.test.ts` that
  run real Deno subprocesses and assert `classifyRun` returns `needs-perms` with
  the exact path. Fails at CI if Deno changes its denial message wording.
- **Advisory reviewer** (`src/advisor.ts`) — optional pre-approval add-on. Sends
  `{task, script, perms}` (not the full log) to a configurable model, returns
  structured flag strings labeled `[advisory]`. Fails open on any error. Enabled
  via `--advisor` flag, `advisor: true` in config, or TUI `/advisor` command
  (toggle/configure with preset + model; tab-completes). Separate
  `advisorProvider`/`advisorModel` config fields allow a different model from
  the proposer.
- **Illegal state elimination** — three redundant derived fields removed:
  `autoEnabled` (was `!!repo`), `autoReturn` (was `!grantsNet(ranWith)`), and
  scoped `Permission { flag: "all" }` (now a discriminated union; `all` is never
  scoped). `advisorEnabled` also removed — `advisorConfig` presence is the
  signal.
- **Skills system** (`src/skills.ts`, `src/tools/invoke-skill.ts`) — a skill is
  a directory `.pagu/skills/<name>/` containing `SKILL.md` (frontmatter +
  instructions, agentskills.io spec) and a `scripts/` subdirectory with
  pre-authored `.ts` files. Denotation: `(prose, ConfigLayer, files, scripts)` —
  extends roles by the same composition law. `invoke_skill` tool: agent names a
  skill script by enum-constrained name; the orchestrator resolves the verbatim
  body from `ctx.activeSkillScripts` (agent never copies content); cage
  validates and auto-approves within the declared permission ceiling.
- **Command policy / `run_task`** (`src/command-policy.ts`, `src/discovery.ts`,
  `src/tools/run-task.ts`) — `run_task` tool: agent passes an exact command
  string (enum-constrained to the allowed-tasks policy). Deny by default: only
  tasks listed in `allowed-tasks` config can run via `run_task`. Discovery scans
  `deno.json`, `package.json`, `Justfile` for available tasks at startup.
  **Type-inference model for permissions:** first cage run with minimal perms
  discovers what the command actually needs → stored in
  `.pagu/inferred-perms.json` (gitignored lockfile); second run cages against
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
  pipeline below is its first caller, at the `Proposal` carrier); `fanOut`
  (monoidal product,
  - immutable carrier) remains deferred. See
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

### Roles — decided behavior (shipped; intended, surfaced — not bugs)

- **Fold order:** defaults → global `config.json` → selected roles (in `--role`
  order) → CLI flags (flags win last; roles are reusable middle layers). Prose:
  base AGENTS/CLAUDE (global then project), then each role's body, concatenated.
- **Merge law** (`mergeLayer`, a monoid): scalars last-write-wins; grants
  (`allow`/`write`) set-union (order-independent); deny-wins lattice when
  explicit denies arrive. See `docs/CONCEPTS.md`.
- **Scopes:** global `~/.config/pagu/roles/<name>.md` (any project), project
  `./.pagu/roles/<name>.md` (tracked/shared — `.gitignore` ignores only
  `.pagu/sessions/`). Same name in both: the project file **shadows** global.
- **Missing `--role <name>`:** **fail loud**, never silently ignored.
- **Runtime `/roles <names>`** **replaces** the active group and re-derives the
  whole effective config (provider, model, envelope/read-scope, prose). Most-
  recent action wins between `/roles` and `/provider`/`/model`; an unknown name
  leaves state unchanged. Repo mode is resolved once at startup, never
  re-prompted. Safe because auto-approve is gated by repo mode, not roles.

### Open

- **Verify the macOS `sandbox-exec` profile on a Mac** — implemented but not yet
  exercised on real hardware (developed/tested on Linux).
- **OS-layer read isolation + Landlock (Linux).** Tier 2 confines writes +
  network but leaves reads broad at the OS layer; per-path read binding / a
  Landlock backend would close subprocess read-confinement.
- **`.gitignore` read-protection.** `--deny-read=<child>` breaks `readDir` of
  the parent, so repo mode applies gitignore denies as **deny-write only**. A
  broad-read script can thus surface a secret's _contents_ to the (local) model
  — no internet exfil, the runner has no net. Fix: per-file read allowlisting,
  content redaction, or a narrower granted read set.
- **Windows OS isolation** (AppContainer / Job Objects).
- **Permission modes** — named envelope bundles generalizing repo mode.
- **A credential-injecting egress proxy** so net-granted scripts never see raw
  secrets.
- **ACP — remaining integration work.** v1 runs in editors but is partial.
  **Shipped** 2026-05-28: history replay on `session/load` (`historyUpdates` +
  `loadSession`); config slash commands (`/model`/`/provider`/`/advisor`
  advertised via `available_commands_update` + routed; `src/commands.ts`);
  **tool-call surfacing** (`script`/`skill-invoke`/`command-invoke` →
  `tool_call`, `result` → `tool_call_update`, live + replay, via one
  `entryUpdate` mapper + the `UI.entries` hook; `src/frontends/acp.ts`).
  Remaining:
  - **`/roles` & `/skills` over ACP** — their no-args path is a TUI-only
    `selectFromList` picker; need a with-args-shared + ACP-text-listing split
    (the TUI keeps its picker). Likely folded into the command-architecture
    generalization (backlog).
  - **Cooperative cancellation** (`session/cancel`) — currently a no-op; needs a
    cancellable `runTask` (ties to the loop substrate — a cancel signal the loop
    checks between turns).
  - **Thinking** → `agent_thought_chunk` — needs provider-layer reasoning
    separation (parse qwen's `<think>` / surface `reasoning_content`),
    model-specific. Also: diff/terminal tool-call content, `· read X` markers.
  - Live-verify the slash-command **invocation format** Zed sends (literal
    `/name …` text is assumed; adjust routing if it sends bare names).
- GUI / computer-use.

### Idea backlog (speculative / paradigm-level)

**Next up: the handler-pipeline follow-ons.** Both the loop substrate and the
composable handler pipeline (v1) shipped 2026-05-28 (`src/loop.ts`,
`src/write/pipeline.ts`; see Shipped). The seam is in; the next slices are its
increments — **config-driven pluggability** (insert custom handlers; the point
where the gate-never-widen law gets _type-enforced_) and **generalizing** the
handler pipeline to the `skills`/`tasks` executors. (Then back to #1: `fanOut` /
multi-agent.)

To knock out one at a time — not commitments. Designed through the compositional
lens (see `AGENTS.md` → Values: functional/compositional core, composition over
inheritance, category-theory/algebraic abstractions) and bound by the invariants
above (esp. #1: no agent exec path). It's a personal harness, so packing ideas
in is fair game — remove what doesn't earn its keep. (Shipped already: config
interop, roles, skills, command policy, ACP frontend — see the Shipped sections
above.)

1. **Composable agent loops — iterative review / multi-agent.** Substrate (v1)
   **shipped** 2026-05-28 (`src/loop.ts`): the turn is a `Step<C>`, `runTask` is
   `loop(turn)`. Remaining: `fanOut` (monoidal product, needs the immutable
   carrier) and multi-agent _later_, the point where "independent actors"
   finally become appropriate. **Author→critic→revise: deferred** — it turned
   out to be an _inner_ loop (sibling to the cage fix-round loop), not
   turn-level `andThen`, and its use case (sharpening proposals on the
   advisor-on human-gate path) is too narrow to justify now. `andThen` stays a
   deferred combinator until a genuine turn-level composition needs it. Also
   queued: unifying the inner cage fix-round loop under a shared inner-loop
   combinator (would gain a second instance if author→critic is ever revived).
2. **Composable handler pipeline — the proposal–handler model made explicit.**
   Core (v1) **shipped** 2026-05-28 (`src/write/pipeline.ts`):
   `write/execute.ts` is `pipeline([cage, approve, run])` over `Step<Proposal>`;
   each stage a named, insertable handler; a **gate** halts. Implements
   `andThen`/`pipeline` in `src/loop.ts`. Remaining increments: **config-driven
   pluggability** (insert custom/plugin handlers — the point where the
   gate-never-widen law gets _type-enforced_, since a plugin is safe by the same
   lattice law as role composition; the set of handlers is the TCB) and
   **generalizing** the pipeline to the `skills`/`tasks` executors. Stays
   value-level; algebraic effect handlers (operation-granularity interception)
   only if a real need surfaces — pagu's one-action-per-turn shape means the
   turn boundary ≈ the effect site, so boundary-level handlers likely suffice.
   Pluggability is also the home for plugins / extensibility (new providers
   behind `chat()`, new frontends behind `UI`/`Approver`).
3. **Read-only-command auto-approve gate → command grammar. Shipped 2026-05-28**
   (`docs/specs/2026-05-28-command-grammar-design.md`; `tasks/grammar.ts` +
   `tasks/defaults.ts` + the `run_command` tool). Auto-approves curated
   read-only commands (`rg`/`git log`/`git diff`, `allow-read` + `allow-run`,
   **no write, no net**) with **agent-supplied args validated by a formal
   grammar**. **Subsumes** `run_task` (its exact-enum = the degenerate
   zero-free-arg grammar — `recognize` generalises `matchesPolicy`; folds in
   part of #4). Arg-safety is **LangSec**: a regular sublanguage of safe argv
   invocations, recognised default-deny (the no-shell architecture is what makes
   it regular). The "read-only" trap (`--pre`, `find -delete`,
   abbreviation/bundling) is handled by a canonical-flag allowlist + the law
   **free args ⇒ read-only ceiling**; the recogniser is a filter, not the
   boundary (perms + sandbox + #5 bound what's possible). Tested by example
   slices + property invariants (totality, positive path generator, negative
   flag injection). **Remaining (deferred):** user-extensible rules via config;
   folder rename `tasks/`→`commands/`; write/net free-arg commands;
   symlink-escape in path containment.
4. **Command-architecture generalization (rule of three).** CLI (flags), TUI
   (slash + arrow-key pickers), and ACP (slash + `availableCommands`) are three
   presentations of the same operations. `src/commands.ts` (the `SlashCommand`
   list + `runCommand`) is the value-level seed (declare-locally / aggregate-
   centrally, see `docs/CONCEPTS.md`); the generalization is a **command core +
   per-frontend presentation adapters**, folding in `/roles`/`/skills` (the
   picker-vs-listing split) and the TUI-native vs generalized distinction.
   Design as its own slice when a third real need pushes on it. Also the home
   for **effect-performing commands** (vs today's pure config-mutation) — e.g.
   `/model` querying the provider's list-models endpoint for settable names.
   Safe re: #1 (human-initiated read to the already-trusted provider host), but
   it's a category shift (the first command with a network effect, run in the
   orchestrator) — model it as an effect/handler, don't bolt it on.

5. **Scoped-isolation sandbox tiers (the GrapheneOS model).** One principle —
   _hide the mechanism from the actor; scope by construction_ — at two layers.
   **Prompt layer: shipped 2026-05-28** (`src/phases/respond.ts`): the model is
   told its _affordances_ ("you have a `write` tool that runs on the machine
   with real effect"), not the cage ("you cannot run it yourself / a separate
   sandboxed process / scratch dir") — the negative framing made small models
   _under-claim_ ("I can't access the filesystem"). The model talks to a port
   (its tools); it is unaware of the adapter (sandbox), exactly like a
   GrapheneOS app that believes it has normal storage while the OS silently
   scopes what it sees. **Enforcement layer (backlog):** make the boundary a
   property of the _environment_, not a checklist of `--allow-*` flags — thread
   only the allowed dirs/files _into_ an isolated view, so out-of-scope paths
   simply don't exist (vs today's name-then-deny). This strengthens invariant #2
   (boundary = environment _and_ perms) and makes "blast radius statically
   enumerable" literal (the radius = the threaded-through mounts); it also kills
   two gotchas — "Deno reports denied paths as referenced" and `absolutizePerm`
   fragility. As **tiers** behind `detectSandbox` (degrade to `none`/`bwrap`, so
   no regression — invariant #5):
   - **Known hosts → native isolation.** Extend the current `bwrap` wrap to
     bind-mount the _read_ scope too (Linux mount namespaces); `sandbox-exec`
     (macOS); Windows AppContainer / Job Objects (currently Open). External
     binaries we shell out to, like `bwrap` today — not code deps.
   - **Remote infra → microVM.** The real use case: run pagu in remote
     infrastructure with granular access to a VPS (Firecracker / krun / Apple's
     container framework; virtiofs threads only the allowed dirs into the
     guest). Full-kernel isolation where the host isn't trusted to begin with.
   - **WASM (speculative).** Capability-scoped by construction — the strongest
     "only threaded-through resources exist" model, and a possible portable
     fallback; open question is running the Deno-TS runner under wasm.
6. **A `Capability` port (run/invoke + discover/list).** `skills`, `tasks`, and
   `commands` each have the **same four-part shape**: _discover/list_ available
   actions, _advertise_ them as a tool, _validate within a ceiling_ (verbatim /
   policy / grammar), _execute_ → a `*-invoke` entry. Three instances now (rule
   of three) → a lawful `Capability` interface (all validators obey
   narrow-never-widen, so it's lawful, not a leaky common base). This is the
   **dispatch-side** sibling of #4's presentation generalization (and of #2's
   execution-side handler pipeline). Also the home for the **availability law**
   already applied to `run_command` (advertise = legal ∩ environment-available —
   `presentDefaultRules`): every capability's advertised set should intersect
   its declared/legal set with what the environment actually offers. Design as
   its own slice; don't force a common interface that leaks.
7. **Model-based / stateful property testing of the session+loop state
   machine.** The property analog of e2e (`fc.commands`): generate random
   operation sequences (`new → prompt → fork → load → rename → prompt …`) and
   assert invariants after each step — e.g. **permissions never widen across a
   session**, **the log is always replayable**, **every approved run is within
   the envelope**. Worth it because the session surface is stateful and the
   interaction space is combinatorially large. (See `AGENTS.md` feedback loops +
   the tdd skill's test-level guidance.)
8. **Test-type audit.** Revisit the existing suite and match each test to the
   right level (example / property / integration / e2e) for what it verifies —
   add property tests for the law-shaped pure cores that currently lean on
   examples; keep effectful coverage on the real thing. Maintenance, not
   paradigm — slot in opportunistically. **Started 2026-05-28:** property tests
   added for the **log codec** round-trip (`parseLog ∘ serializeLog = id`) and
   the **envelope** containment-lattice laws (reflexive / `all`-is-top /
   deny-wins / allow-monotone / transitive). **Remaining targets:** ConfigLayer
   monoid (associativity + identity, permission-lattice merge), `classify`,
   `commands.ts` dispatch.
   - **Finding (log codec fence collision) — FIXED 2026-05-28.** The property
     surfaced a real latent bug: a body line `~~~` (e.g. markdown fences in
     model output or a file read) was read as the closing fence and truncated
     the log — data loss in the event store. Fixed with **variable-length
     fences** (CommonMark-style): the serializer picks a `~` run longer than any
     in the body and the parser matches the close by length (`\1`).
     Backward-compatible (old `~~~` logs still parse). The round-trip property
     now covers bodies with arbitrary `~` runs. Remaining domain constraints are
     structural, not bugs: joined list elements (args/perms/ran-with) carry no
     newline/space and attr values (ids/source/program) no `"`/newline — those
     fields never hold such values by construction.

Suggested order: the handler-pipeline increments (pluggability, generalize to
skills/tasks) → back to #1 (`fanOut` / multi-agent). Re-sequence freely as
constraints surface. ACP integration gaps (Open) are independent and can slot in
anytime; #5's enforcement-layer tiers, #6's `Capability` port, and #7/#8's
testing work are likewise independent.

### North Star (paradigm-level): pagu's core as an agent-workflow SDK

The composability work above is in service of a larger aim — **expose the lawful
compositional core as a programmatic SDK/library** so people author their own
agent loops on it: implement→refine→iterate, explore (fan-out) → synthesize
(merge), not just write→advise→run. The differentiator from graph frameworks
(LangGraph et al.) is the pairing of a **lawful algebra** (typed combinators
with laws) with pagu's **security envelope**: invariant #1 holds for SDK
consumers too — every composed loop still routes effects through cage → gate →
runner, and the gate-never-widen law makes third-party loops/extensions safe by
construction. _"Compose any workflow; the blast radius stays statically
enumerable."_

**Deepening — separate declaration from evaluation.** Today's combinators are
already lazy in the _final_ (function) encoding: `loop`/`andThen`/`pipeline`
build an unrun `Step` value. Taking it further means an _initial/free_ encoding
— a reified **workflow IR as inspectable data**
(`Loop(w) | AndThen(w,w) | FanOut([w]) | Turn | …`) that you build then
`interpret`. That makes a workflow capturable, serializable, **savable**, and
dispatchable — and (the pagu payoff) **auditable before evaluation**: the blast
radius of a _whole workflow_ becomes statically enumerable, not just a single
script. Declaration/evaluation separation becomes a **security lever**, not just
ergonomics. The orchestrator then becomes a **dispatcher** of workflow values;
executable artifacts are captured + persisted + run when wanted — generalizing
what pagu already does for one proposed script (authored → cage-tested → saved →
run on approval) to whole workflows. Dovetails with the CQRS/event-store
paradigm (the workflow is a value; its interpretation is the read side).

**Discipline:** this is the _why_, not a next step. Keep shipping the increments
(they fill out the algebra); reify to a workflow IR only when
save/dispatch/audit needs are concrete; an SDK is a hard API-stability
commitment — freeze the public surface (`context.ts` / `UI` / `Approver` / the
combinators) only once the primitives have settled.
