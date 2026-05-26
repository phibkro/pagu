# pagu — design

> Status: draft for iteration. Command: `pagu`. Named for _Paguroidea_, the
> hermit-crab superfamily — soft and untrusted inside (the LLM), operating only
> through a hard, borrowed, disposable shell (the sandboxed runner).

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

- GUI/computer-use (mouse/screen) — CLI first, expand only if needed.
- Conversation forking — planned; borrow Pi's implementation later.
- Multi-provider abstraction beyond the first provider.
- Uniform OS-level sandboxing across every platform (see Security tiers).

## Core principle: the model has no execute capability

The agent's only tools are **read** (allowlisted) and **write** (to the
conversation log / scratch). There is no `bash`/exec tool. Execution happens in
a separate process the agent cannot invoke; the only trigger is a human
approval.

## Phase FSM

The loop is a small state machine. **Each phase is a separate, short-lived
process launched with exactly that phase's permissions** — so the runtime
sandbox, not just our code, enforces the boundary. Phases are stateless: each
folds the conversation log and appends new events.

| Phase                | process permissions                                 | tools                 | advances when                        |
| -------------------- | --------------------------------------------------- | --------------------- | ------------------------------------ |
| **Observe** (query)  | read = allowlist; net = provider only               | `read`                | model has needed context             |
| **Author** (command) | write = log/scratch; net = provider only            | `write`               | model emits a script                 |
| **Review**           | _(no agent process)_                                | —                     | **human** approves / rejects / edits |
| **Run**              | runner: scoped perms, in OS sandbox where available | — (runner, not agent) | script exits                         |
| → Observe            |                                                     |                       |                                      |

Read _results_ persist in the model's context across phases, so the agent never
simultaneously holds read + write.

## State model: the conversation log _is_ the event store

There is one canonical artifact: an append-only, git-backed conversation log.
Observations, proposed scripts, approvals, and run results are first-class turns
woven into it (CQRS event stream). Desktop state is the projection (fold) over
those events. Git history gives audit + (later) forking = branching the log.

### Format: Markdown + structured fenced blocks

Human-diffable prose with typed, parseable fenced blocks:

- `` ```pagu:observation `` — what a read returned (source + content).
- `` ```pagu:script `` — a proposed script (lang + body).
- `` ```pagu:perms `` — permissions discovered for that script (the
  zero-permission discovery run's findings).
- `` ```pagu:decision `` — human approve/reject/edit + rationale.
- `` ```pagu:result `` — runner output + exit status + the exact perms it ran
  with.

One file, readable by a human, parseable by the harness, clean git diffs.

## Approval model

- **Per-script explicit by default.**
- **Auto-approve rules** may be configured. Safety invariant: a rule fires only
  when the script's **discovered permission set ⊆ a pre-vetted envelope**,
  verified by the zero-permission discovery run + lint — never by trusting the
  agent's description. So auto-approve can never silently widen the real
  capability surface.
- **Modes** = named bundles of such envelopes (à la Claude Code's permission
  modes), e.g. a `scratch-readonly` mode that auto-runs only scripts proven to
  touch nothing beyond a read-only scratch.

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
2. **Opt-in OS isolation — platform-specific hardening.** bubblewrap / Landlock
   (Linux), sandbox-exec/seatbelt (macOS), AppContainer/Job Objects (Windows).
   Best-effort per platform; layered on top of the floor where available.

Honest ceiling: on a platform with only tier 1, a Deno/V8 escape would breach
isolation. Tier 2 closes that where the OS supports it.

## Threat model (load-bearing parts)

- **Boundary = no-exec-capability + mandatory per-proposal human review.**
- **Reads are untrusted input** — the prompt-injection / exfiltration surface.
  Adversarial content in read material can steer what the agent _proposes_; the
  human review of every proposal is the backstop (Dual-LLM / quarantine
  posture). The per-turn gate bounds the read → propose → run → read
  amplification.
- **Runner perms cap an approved-but-buggy script**; **harness phase perms cap a
  buggy/compromised harness**.
- When approved scripts need egress, a credential-injecting proxy (e.g. Claw
  Patrol) can mediate so the script never sees raw secrets.

## Tech & UX

- **Runtime:** Deno (TypeScript). Cross-platform, runs TS directly,
  `deno compile` → single binary, permission model is the security floor.
- **Core in plain TypeScript — no Effect.** effect-smol (v4) was evaluated and
  dropped: it's a large conceptual dependency that works _against_ pagu's whole
  value prop (small TCB, auditable in one sitting, minimal supply chain).
  Revisit only if orchestration pain justifies it, and even then keep it out of
  the security-critical core. (If adopted later, vendor the Effect repo as a
  read-only `git subtree` for agent reference — deferred until that decision.)
- **Provider:** Ollama first (native tool-calling), BYO key; pluggable.
- **Harness:** our own minimal loop + phase FSM, written from scratch — inspired
  by Pi (loop shape, tool-call parsing), not forked. Smaller TCB is the point,
  and from-scratch bakes in the no-exec/phase model from line one. `pi-ai` kept
  as an optional fallback if multi-provider lands.
- **Runner shell-out:** generated scripts call CLIs via `Deno.Command`
  (low-level) or `dax` (`$`-style, the Bun-Shell analog) — both gated by
  `--allow-run=<specific binaries>`, surfaced by the discovery run.
- **UX:** CLI-first ("terminal with an LLM"); TUI for the transcript + approval
  view; GUI only if a real need appears.

## Build & packaging

- Standalone git repo (dev checkout lives in a gitignored subfolder of the
  homelab repo; published separately, e.g. JSR `@.../pagu`).
- No build step (Deno runs TS); distribute via `deno install` / `deno compile`.

## Deferred / open

- Conversation **forking** mechanism (borrow Pi).
- OS-isolation backends beyond Linux.
- GUI/computer-use.
- Multi-provider layer.
