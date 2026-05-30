# ADR-0003: Per-project config file, with repo-mode gating its grants

- Status: Accepted (designed; implementation pending — hand to `tdd`)
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

**Repo-mode gates its grants**, enforced **structurally**:

- Non-security keys (`provider`, `model`, `baseURL`, `maxTokens`, `advisor*`,
  `hide`/`reveal`/`hideSecrets`/`hideGitignored`) **always** apply.
- Permission grants (`allow`, `write`, `allowedTasks`) apply **only when repo
  mode is consented** for this repo (reuse the existing per-repo "I trust this
  repo" signal).
- `handlers` (code paths) are **never** honored from a project config — loading
  orchestrator code is not something repo-mode consents to.
- Mechanism: a pure `sanitizeProjectLayer(layer, repoMode)` runs at load, before
  the fold — it strips the grant fields when not in repo mode and always strips
  `handlers`. The layer entering the fold **cannot carry untrusted grants by
  construction**; this is testable as a law (`grants present ⇒ repoMode`), the
  strongest enforcement rung (see the enforcement ladder in `AGENTS.md`).

## Consequences

- Useful per-project provider/model/concealment work always; per-project
  `allowed-tasks`/`allow` work once you've consented repo-mode (you already do
  that to let scripts touch the repo) — so no _new_ trust step for the common
  case.
- Opening a hostile repo with a `.pagu/config.json` cannot widen the envelope or
  load code: invariant #3 is preserved **by the sanitize, not by prose**.
- `handlers` stays global/explicit-injection only — a deliberate capability gap.
- On ship: update the canonical fold order in `docs/CONCEPTS.md` (merge law) and
  add the `sanitizeProjectLayer` law to `docs/INVARIANTS.md`. Tracked in
  `ROADMAP.md`.
