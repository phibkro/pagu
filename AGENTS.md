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
- **Clarity over brevity; readability over code-writing velocity; security over
  utility.** When these trade off, optimize in that order — and surface the
  tradeoff. (Hence: `permissions/` not `perms/`, `// effects:` markers, the
  pure/shell split — chosen for the next reader, not for typing speed.)

## Architecture map (where things live)

Security-critical pure cores (unit-tested — change with care + tests first):

- `src/log/` — `pagu:*` block parse/serialize (the event store format).
- `src/permissions/envelope.ts` — `covers`/`within`/`withinEnvelope`
  (auto-approve gate); `gitignore.ts` — deny derivation via `git ls-files`.
- `src/runner/run.ts` — scoped `deno run`; `classify.ts` — cage result → ok /
  needs-perms (discovery) / bug; `sandbox.ts` — **OS sandbox tier** that wraps
  the run (bubblewrap on Linux, `sandbox-exec` on macOS) as defense-in-depth
  beneath the Deno floor: denies network + confines writes (so an `--allow-run`
  subprocess, which Deno does NOT bound, is still contained). Pure
  `wrapForSandbox` builds the wrapper argv; `detectSandbox` picks the tier
  (`none` when unavailable — no regression). Applies to both the cage and the
  real run.

The loop and its frontends:

- `src/agent.ts` — **the I/O-agnostic core**: `runTask(ctx, task)` +
  `AgentContext`/`Approver`/`UI`. The one seam between core and frontends.
- `src/setup.ts` — flags→config merge + `buildContext` (shared by frontends).
- `src/cli.ts` — one-shot frontend (stdin approver). `src/tui.ts` — REPL
  frontend (colored, multi-turn). They differ _only_ in UI + Approver.

Provider + phases + config:

- `src/provider/chat.ts` — `chat()` **dispatcher** (OpenAI Chat Completions,
  default) → `anthropic.ts` (native Messages API) by `format`. Add providers
  here, behind `chat()`.
- `src/phases/respond.ts` — the single phase entrypoint: converses, calls `read`
  to inspect files, and proposes a script with `write` only when an action is
  needed (read stdin, call the model, emit events); `spawn.ts`, `messages.ts`,
  `ipc.ts` support it. **Streaming:** the phase writes model tokens to its
  **stderr** as a live display side-channel (`spawn.ts` forwards them to the
  `UI.stream` sink); its **stdout** stays reserved for the structured
  `{entries}` JSON. The side-channel carries no capability — the security
  boundary is unchanged. Only the model's text streams; exfil-gated run output
  never does.
- `src/{config,repo,session}.ts` — config presets and instruction load
  (AGENTS.md, with a CLAUDE.md fallback per scope, prose only); git-repo detect
  and per-repo memory; envelope building and auto-approve policy.
- `src/envfile.ts` — opt-in, per-folder-consented `.env` loading (via
  `@std/dotenv`) so keys like `ANTHROPIC_API_KEY` need no manual export.
- `src/conversations.ts` — the conversation-session store: per-project
  `.pagu/sessions/<id>.log.md` (id = immutable ISO timestamp). Log entries are
  the source of truth; a YAML **frontmatter** header holds metadata (optional
  `name`, `created`) — last-modified comes from the filesystem mtime, not
  stored. Title = `name` ?? first user message. `buildContext` resolves which
  session a run uses; `AgentContext.switchSession`/`rename` let the TUI change
  and name sessions mid-REPL (mutate the log array in place + repoint persist).
  Note: `session.ts` is the _permission_ session; this is _conversations_.

## Feedback loops

- `deno test --allow-run --allow-read --allow-write --allow-net --allow-env` —
  the suite (pure cores + HTTP-mocked providers + sandboxed integration). Keep
  it green.
- `deno fmt && deno lint && deno check src` before committing — or enable the
  pre-commit hook once per clone: `git config core.hooksPath .githooks` (runs
  fmt-check + lint + check + tests; skips if deno isn't on PATH).
- **Live-verify** real changes against Ollama (default provider). The no-stdin
  recipe (auto-approves in repo mode, so it's self-contained):
  ```sh
  R=$(mktemp -d); (cd "$R" && git init -q && for f in a b c; do echo x>$f.txt; done && git add -A && git -c user.email=t@t -c user.name=t commit -qm i)
  cd "$R" && pagu 'count the .txt files and write the number to count.txt' --repo </dev/null
  ```
- The **cage self-test** is the product's own feedback loop: a proposal's bugs
  feed back to the model (bounded) before a human sees it.
- **Test the pure core by law; test the effectful surface against the real
  thing.** Pure cores (the merge monoid, envelope, classify, log codec) get
  unit/property tests — correct by construction. The effectful surface (IO,
  runner, providers) is where errors hide, so exercise the _real system_ — real
  `deno` subprocesses, a real local HTTP server — over isolated mocks.
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
  are **write-only** at runtime (read-protection deferred).
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
