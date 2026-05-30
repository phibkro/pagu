# ADR-0003: Per-project config file, with repo-mode gating its grants

- Status: Accepted (implemented 2026-05-30 — `src/config/project-config.ts`,
  wired in `src/config/setup.ts`)
- Date: 2026-05-30

## Context

pagu reads a **global** `~/.config/pagu/config.json` only; there is no
per-project base config (roles/skills/profiles/personalities and `AGENTS.md`
already layer per-project, but the base config does not). A project wants to pin
its provider/model and, ideally, its `allowed-tasks`.

The tension is invariant #3 (**reads are untrusted**): a `.pagu/config.json`
would be **auto-loaded just by being in the repo you opened**. `ConfigLayer`
carries not only display/substrate keys but **permission grants**
(`allow`/`write`/`allowedTasks`) and **`handlers`** (before-approve handler
_code paths_). So a naive auto-loaded project config lets a hostile repo
**self-grant permissions or load code into the trusted orchestrator** — exactly
what #3 forbids. (Contrast the existing precedents: project `AGENTS.md` is
auto-loaded but only as _prose_ — it informs the model, which still has no exec
path + the gate; project _roles_ can carry grants but are **opt-in** via
`--role`.)

## Decision

Add **`.pagu/config.json`** (tracked/shared), auto-loaded, folded **after global
`config.json` and before the opt-in bundles + flags**:
`defaults ⋄ global config.json ⋄ project config.json ⋄ profile/roles/skills ⋄
flags`
(an auto-loaded repo default overrides the global default, but loses to anything
you explicitly named or a flag).

**Repo-mode gates everything that isn't harmless from an untrusted repo**,
enforced **structurally** by an **allowlist** (default-deny). _Amended during
implementation:_ the initial classification called `provider`/`baseURL` and the
concealment keys "non-security", but **`baseURL` is the egress destination** (a
hostile repo could redirect the whole conversation — including allowlisted read
content — to an attacker) and `reveal`/`hideSecrets`/`hideGitignored` **weaken**
concealment. So the only keys safe from an untrusted project config are the ones
that can't redirect egress, widen access, weaken concealment, or load code:

- **Always apply:** `model`, `maxTokens`, and `hide` (which only _adds_
  concealment). _An untrusted repo may pick the model name, cap tokens, and hide
  more — nothing else._
- **Repo-mode-gated** (apply only under the consented per-repo "I trust this
  repo" signal): egress (`provider`, `baseURL`, `apiKeyEnv`, `format`), advisor
  egress (`advisor*`), grants (`allow`, `write`, `allowedTasks`), and
  concealment-_weakening_ (`reveal`, `hideSecrets`, `hideGitignored`).
- `handlers` (code paths): **never**, even under repo mode — loading
  orchestrator code is not something repo-mode consents to.
- Mechanism: a pure `sanitizeProjectLayer(layer, repoMode)` runs at load, before
  the fold. Outside repo mode it keeps **only** the always-apply allowlist
  (`UNTRUSTED_SAFE`); it always strips `handlers`. The layer entering the fold
  cannot redirect egress / widen the envelope / weaken concealment / inject code
  **by construction** — testable as a law (`untrusted ⇒ only UNTRUSTED_SAFE`),
  the strongest enforcement rung. Allowlist, so a _future_ `ConfigLayer` field
  is gated by default, not accidentally always-applied.

Example `.pagu/config.json` (the model line always applies; `allowed-tasks` only
under repo mode):

```json
{
  "model": "claude-opus-4-8",
  "provider": "anthropic",
  "allowed-tasks": ["deno task lint"]
}
```

## Consequences

- Per-project `model`/`maxTokens` work everywhere; per-project provider/baseURL,
  `allowed-tasks`/`allow`, etc. apply once you've consented repo-mode (you
  already do that to let scripts touch the repo) — so no _new_ trust step for
  the common trusted case.
- Opening a hostile repo with a `.pagu/config.json` cannot redirect egress,
  widen the envelope, weaken concealment, or load code: invariant #3 is
  preserved **by the sanitize, not by prose**.
- `handlers` stays global/explicit-injection only — a deliberate capability gap.
- **`createContext` (the hermetic SDK constructor) DOES load
  `.pagu/config.json`** — it is _project-scoped_ (like roles/profiles, which
  `createContext` already loads via `projectBase`), not _ambient_ (the
  docstring's "no global config.json / no cwd `.env`" still holds). Its grants
  are gated by the embedder's `repo` opt just like every other path. (Closed the
  implementation-time gap: the docstring now states this.)
- On ship: update the canonical fold order in `docs/CONCEPTS.md` (merge law) and
  add the `sanitizeProjectLayer` law to `docs/INVARIANTS.md`. Tracked in
  `ROADMAP.md`.
