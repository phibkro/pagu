# pagu

A local, cross-platform agent you use like a terminal — but **the model can
never execute anything**. It reads context and _authors_ a script into an
auditable conversation log; you approve it; a separate sandboxed process runs
it. Named for _Paguroidea_ (hermit crabs): soft and untrusted inside, operating
only through a hard, borrowed, disposable shell.

See [`DESIGN.md`](./DESIGN.md) for the full rationale and threat model.

## How it works

You **chat** with pagu. It answers normally and reads allowlisted files (via a
`read` tool) when that helps. Only when finishing the task actually requires
changing the system does it switch into **action mode** and propose a script —
otherwise it just replies. Each turn runs as a **separate `deno` process**
launched with only that turn's permissions (`--allow-net=<model>`,
`--allow-read=<allowlist>` — never write or run).

When an action _is_ needed, the proposed script goes through:

1. **Cage self-test** — run in a no-net, scratch-only sandbox to catch bugs (fed
   back to the model to fix) and discover the permissions it needs.
2. **Review** — you see the script and the exact permissions it will run with,
   and answer **y/n** (auto-approved in `--repo` mode within the repo envelope).
3. **Run** — a separate `deno run --no-prompt <granted flags>` executes it;
   output auto-returns to the conversation only if no network was granted, so
   pagu can see the result and continue or wrap up.

The model has no execute capability at any point; the human gate sits between
proposal and run.

## Requirements

- [Deno](https://deno.com/) 2.x
- _Optional, recommended:_ **bubblewrap** (`bwrap`) on Linux for the OS sandbox
  tier (a kernel-level wall beneath Deno's permissions; macOS uses the built-in
  `sandbox-exec`). Without it, runs fall back to the Deno-permission floor.
- A tool-calling model behind an **OpenAI Chat-Completions-compatible**
  endpoint. Out of the box: local **Ollama** (default, `qwen3.5:9b`). Also any
  compatible provider — **OpenRouter** (one key → 300+ models incl.
  Anthropic/OpenAI), OpenAI, Groq, LM Studio, vLLM — via config (below).
  **Anthropic** is also supported natively (its own Messages API).

## Install

Run this **from the repo root** (so `deno.json` is found):

```sh
deno install --global --force --config deno.json \
  --allow-run --allow-read --allow-write --allow-env \
  -n pagu ./src/cli.ts
```

The **`--config deno.json` is required**: pagu's imports resolve through that
file's import map, and `deno install --global` otherwise ignores `deno.json` (it
would fail with `Import "@std/…" not a dependency`). Then make sure
**`~/.deno/bin` is on your `PATH`** (deno prints this on install) so `pagu` is
runnable — e.g. add `export PATH="$HOME/.deno/bin:$PATH"` to your shell rc.

The orchestrator needs run/read/write; each phase subprocess still gets only its
own scoped permissions regardless of what the orchestrator holds.

## Usage

```sh
pagu "count the .txt files in ./photos and write the total to count.txt" \
  --allow ./photos
```

Bare **`pagu`** in a terminal (or `pagu --tui`) launches an interactive REPL —
type tasks one after another, with the same security model and a shared
conversation log across turns (multi-turn context).

**Conversations** are stored per-project under `./.pagu/sessions/` (gitignored),
each an `<id>.log.md` with a small YAML frontmatter header (name, created). Each
launch starts a **new** conversation by default; `--continue` resumes the latest
and `--list-sessions` shows them all. In the TUI, `/sessions`, `/new`,
`/open <n>`, `/fork`, and `/rename <name>` manage them live; `/history [n|all]`
recalls past messages and `/clear` deletes the active conversation (after a
confirm). Switch model/provider mid-session with `/model <name>` and
`/provider <name>` (`/provider` alone lists them).

Flags:

- `--allow <path>` (repeatable) — read-allowlist the agent may inspect (defaults
  to `.`).
- `--model <name>` — model id (default `qwen3.5:9b`).
- `--provider <preset>` — `ollama` (default), `openrouter`, `openai`, or
  `anthropic`.
- `--base-url <url>` — override the API root for a custom OpenAI-compatible
  endpoint.
- `--session <id>` — open a specific stored conversation (see
  `--list-sessions`).
- `--continue` — resume the most recent conversation instead of starting new.
- `--list-sessions` — print this project's saved conversations and exit.
- `--log <file>` — use an explicit log file, bypassing the session store.
- `--write <dir>` (repeatable) — directories scripts may write to.
- `--no-sandbox` — disable the OS sandbox tier (the Deno-permission floor still
  applies to every run).
- `--repo` — **repo mode**: grant read+write to the current git repo and
  **auto-approve** scripts confined to it (no per-script prompt). Safe because
  git is your undo buffer, the runner has no network, and `.gitignore`'d paths
  are denied write. "Safe computer use" for a codebase.

At the review prompt, pagu prints the script and the exact permissions it will
run with; answer **`y`** to approve and run, anything else to reject.

## Config (optional)

Zero-config works. To customize, drop files in `~/.config/pagu/` (or
`$XDG_CONFIG_HOME/pagu/`):

`config.json` — structured settings (CLI flags override these):

```json
{
  "provider": "openrouter",
  "model": "anthropic/claude-sonnet-4.5",
  "allow": ["/home/me/work", "/home/me/notes"]
}
```

`provider` is a preset (`ollama` / `openrouter` / `openai` / `anthropic`); each
knows its base URL and which **env var** holds the API key
(`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) — so secrets never
live in the config file. `anthropic` uses Anthropic's native Messages API; the
rest use the OpenAI format. Override a preset with `baseURL` / `apiKeyEnv` /
`format` for any other endpoint. Default is local `ollama` (no key, private).

> **Anthropic note:** the `anthropic` preset uses an **API key**
> (pay-as-you-go). Your Claude **Pro/Max subscription cannot be used** —
> Anthropic prohibits subscription OAuth in third-party tools. Use an API key,
> or reach Claude via `openrouter`.

> **Privacy:** with a **cloud** provider, the agent's _observations_ (file
> contents it reads) are sent to that provider. The sandboxed runner blocks
> _script_ exfiltration, but the agent's reads always go to whichever model you
> point at. **Local Ollama keeps everything on your machine.**

`AGENTS.md` — free-form agent instructions, injected into the prompts. This is
the cross-tool standard (also read by Codex, Cursor, Copilot, …), so one file
guides pagu and your other agents. pagu merges a **global**
`~/.config/pagu/AGENTS.md` (machine notes) with a **project-local**
`./AGENTS.md` (this repo). If you use Claude Code, pagu **falls back** to
`~/.claude/CLAUDE.md` / `./CLAUDE.md` when the corresponding `AGENTS.md` is
absent — so no duplication (only the prose; pagu never reads `.claude/`
settings). For example:

```markdown
I'm on NixOS with bash. Projects live under ~/work. Prefer ripgrep over grep.
Don't touch ~/.ssh or anything under /etc.
```

A malformed `config.json` is a hard error (it won't silently fall back).

**API keys / `.env`:** pagu reads keys from the process environment (e.g.
`ANTHROPIC_API_KEY`), so `export` them or use your shell's env. As a
convenience, if a `.env` sits in the working directory, pagu offers **once per
folder (remembered)** to load it into the environment — gated by a prompt
because sourcing cwd env is a small trust decision. Gitignore your `.env`.

## Tests

```sh
deno test --allow-run --allow-read --allow-write --allow-net --allow-env
```

## Status

Working: **chat-or-act** loop (converse, act only when needed) → **cage
self-test** (self-correct + permission discovery) → y/n approve → sandboxed run,
with results fed back for multi-step turns; **repo mode** auto-approve; **CLI +
TUI** frontends (the TUI **streams** replies live with a progress spinner and
slash commands); **per-project conversation sessions** (list / new / open /
fork, `--continue`); **OS sandbox tier** (bubblewrap / sandbox-exec — denies
network and confines writes beneath the Deno floor); providers **Ollama /
OpenRouter / OpenAI / Anthropic**; AGENTS.md + config. See `AGENTS.md` for how
to work in the repo.

Deferred (see `DESIGN.md`): OS-layer **read** isolation (writes + network are
done; reads still rely on the Deno floor), Landlock, `.gitignore`
read-protection.
