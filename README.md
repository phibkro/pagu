# pagu

A local, cross-platform agent you use like a terminal — but **the model can
never execute anything**. It reads context and _authors_ a script into an
auditable conversation log; you approve it; a separate sandboxed process runs
it. Named for _Paguroidea_ (hermit crabs): soft and untrusted inside, operating
only through a hard, borrowed, disposable shell.

See [`DESIGN.md`](./DESIGN.md) for the full rationale and threat model.

## How it works

A small capability-phased loop, each phase a **separate `deno` process**
launched with only that phase's permissions:

1. **Observe** — reads allowlisted files (`--allow-read=<allowlist>`,
   `--allow-net=<model>`) to gather context.
2. **Author** — proposes one Deno-TypeScript script via the `write` tool
   (`--allow-net=<model>` only — _zero_ filesystem access).
3. **Review** — you read the script and grant the exact permissions it may run
   with.
4. **Run** — a separate `deno run --no-prompt <granted flags>` executes the
   approved script; output auto-returns only if no network was granted.

The model has no execute capability at any point; the human gate sits between
proposal and run.

## Requirements

- [Deno](https://deno.com/) 2.x
- A tool-calling model behind an **OpenAI Chat-Completions-compatible**
  endpoint. Out of the box: local **Ollama** (default, `qwen3.5:9b`). Also any
  compatible provider — **OpenRouter** (one key → 300+ models incl.
  Anthropic/OpenAI), OpenAI, Groq, LM Studio, vLLM — via config (below).

## Install

```sh
deno install --global --force \
  --allow-run --allow-read --allow-write --allow-env \
  -n pagu ./src/cli.ts
```

The orchestrator needs run/read/write; each phase subprocess still gets only its
own scoped permissions regardless of what the orchestrator holds.

## Usage

```sh
pagu "count the .txt files in ./photos and write the total to count.txt" \
  --allow ./photos
```

Flags:

- `--allow <path>` (repeatable) — read-allowlist for the Observe phase (defaults
  to `.`).
- `--model <name>` — model id (default `qwen3.5:9b`).
- `--provider <preset>` — `ollama` (default), `openrouter`, or `openai`.
- `--base-url <url>` — override the API root for a custom OpenAI-compatible
  endpoint.
- `--log <file>` — conversation log path (default `pagu.log.md`).
- `--write <dir>` (repeatable) — directories scripts may write to.
- `--repo` — **repo mode**: grant read+write to the current git repo and
  **auto-approve** scripts confined to it (no per-script prompt). Safe because
  git is your undo buffer, the runner has no network, and `.gitignore`'d paths
  are denied write. "Safe computer use" for a codebase.

At the review prompt, enter the permissions to grant the script (e.g.
`allow-read=./photos allow-write=./count.txt`), blank for none, or `n` to
reject.

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

`provider` is a preset (`ollama` / `openrouter` / `openai`); each preset knows
its base URL and which **env var** holds the API key (`OPENROUTER_API_KEY`,
`OPENAI_API_KEY`) — so secrets never live in the config file. Override a preset
with `baseURL` / `apiKeyEnv` for any other OpenAI-compatible endpoint. Default
is local `ollama` (no key, fully private).

> **Privacy:** with a **cloud** provider, the agent's _observations_ (file
> contents it reads) are sent to that provider. The sandboxed runner blocks
> _script_ exfiltration, but the agent's reads always go to whichever model you
> point at. **Local Ollama keeps everything on your machine.**

`AGENTS.md` — free-form agent instructions, injected into the prompts. This is
the cross-tool standard (also read by Codex, Cursor, Copilot, …), so one file
guides pagu and your other agents. pagu merges a **global**
`~/.config/pagu/AGENTS.md` (machine notes) with a **project-local**
`./AGENTS.md` (this repo). For example:

```markdown
I'm on NixOS with bash. Projects live under ~/work. Prefer ripgrep over grep.
Don't touch ~/.ssh or anything under /etc.
```

A malformed `config.json` is a hard error (it won't silently fall back).

## Tests

```sh
deno test --allow-run --allow-read --allow-write --allow-net
```

## Status

v1: the full observe → author → approve → run loop works against a local model.
Deferred (see `DESIGN.md`): permission discovery + auto-approve modes,
multi-turn self-correction, git-backed log, TUI, conversation forking, OS-level
sandbox tiers beyond Deno permissions.
