---
summary: "Forward plan for pagu's box + gate product, ordered by delivery slice."
tags: [roadmap, planning]
---

# pagu — roadmap

The live product is the box + gate pair defined by
[ADR-0004](docs/decisions/0004-pivot-to-sandbox-plus-gate.md) and
[ADR-0005](docs/decisions/0005-grant-schema-and-gate-boundary.md), with profile
growth and telemetry governed by
[ADR-0006](docs/decisions/0006-profiles-growth-and-telemetry.md).
[CONTEXT.md](CONTEXT.md) owns durable design; this file owns sequence and
remaining work.

## Delivery slices

| Slice                   | Outcome                                                                                                          | Status      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------- |
| 1 — consolidate         | Import the cross-platform `pagu-box` history and preserve its compatibility package.                             | ✓ shipped   |
| 2 — policy core         | Strict schema v0, bottom policy, grant shape, narrow-only project fold.                                          | ✓ shipped   |
| 3 — enforcement adapter | Pure Linux lowering, `--policy`, exact `--explain`, fail-loud unsupported platforms.                             | ✓ shipped   |
| 4 — gate MVP            | Typed append-and-await request channel; refuse/auto/operator tiers; once/session/persist state; retained events. | ✓ shipped   |
| docs rewrite            | Replace live harness-era documentation and re-arm documentation drift checks.                                    | ✓ shipped   |
| 5 — apply grants        | Relaunch/resume, operator/herdr surface, once consumption, session binding, enforcement-time canonicalization.   | ✓ shipped   |
| 6 — profiles/telemetry  | Six curated category policies, named resolution, CI assertions, and a standalone event-log telemetry projection. | ✓ shipped   |
| 7 — harness state       | Compose harness-scoped auth/session state into every gate-owned launch and relaunch.                             | ✓ shipped   |
| 8 — Claude resume       | Verify exact `claude --resume UUID` through the shared relaunch lifecycle.                                       | ✓ shipped   |
| 9 — profile hardening   | Infer the harness, restore Nix-daemon environment parity, and stand down inner Codex gating.                     | ✓ shipped   |
| 11 — denial spike       | Bound seccomp user-notif feasibility for one structured, supervisor-owned denial record.                         | ✓ verified  |
| 12 — denial evidence    | Opt-in compiled-deny-driven `open`/`openat` evidence with a strict v1 JSONL event.                               | ✓ shipped   |
| 13 — fresh gated launch | Attributed fresh Codex/Claude launch and UUID-bound widen/resume.                                                | ✓ shipped   |
| homelab migration       | Consume this repository as the flake input; remove source patching and the old `pagu-box` input.                 | next        |

## Slice 13 fresh-launch boundary

- `pagu gate` starts fresh when `--harness codex|claude` is supplied without
  `--session` (or with `--fresh`); the existing session form still resumes.
- Codex receives a generated, inert nonce marker in its initial prompt. The gate
  snapshots session IDs before spawn, then polls new rollout contents until the
  exact marker identifies its UUID; unrelated concurrent sessions are ignored.
- Claude receives a caller-generated UUID through `--session-id`, so its fresh
  identity is bound by construction without polling the session store.
- Requests arriving during discovery wait behind the same mounted socket. Once
  gate-session v2 retains the bound UUID and `initial: fresh`, every grant and
  widened launch uses that UUID through the existing resume adapter.
- The packaged non-nested journey verified fresh Codex authentication,
  decoy-concurrent nonce attribution, and fresh → widen → context-preserving
  resume. Herdr launch wiring and homelab configuration remain operator-owned.
- The accepted threat scope is cooperative concurrent peers. Isolation against
  a hostile peer writing the shared Codex session store remains deferred.

## Published integration boundary

- Schema-v0 profile grants have one published machine-readable target at
  `schemas/profile-grant-v0.schema.json`: the complete `PolicyV0` artifact
  accepted by `pagu-box --policy`. This unblocks Flow-side lowering,
  `SandboxFactory`, and named credential channels without creating a second
  authority format or carrying secret values.
- Gate-derived grants retain their distinct published structural contract at
  `schemas/grant-v0.schema.json`; `parsePolicy` and `parseGrant` remain the
  semantic validators for their respective artifacts.
- `pagu-box --evidence` remains the supported harness integration adapter. A
  general arbitrary-harness gate/resume port is deferred to a larger boundary
  design rather than added to Slice 13.

## Slice 12 bounded denial-evidence boundary

- Linux seccomp user-notif is verified unprivileged and remains the preferred
  substrate shared with future block/ask.
- `--observe-denials` is off by default. When present, the policy adapter passes
  deny rules derived from its one `CompiledPolicy` value to the outside
  supervisor and rejects logs below compiled writable roots.
- Evidence v1 covers lexically canonical UTF-8 absolute `open`/`openat` paths:
  existing files match exactly; directory and missing-path masks cover
  descendants. Category profile context is retained when available.
- Full-policy classification, relative/dirfd/cwd/symlink/rename handling,
  `openat2`, other syscall families, and tier-3 auto-request remain deferred.
- `LD_PRELOAD` remains only a partial diagnostic fallback; kernel audit logging
  is disqualified by privileged collection.

## Slice 9 shipped boundary

- `pagu gate` infers Codex or Claude from exactly one matching session store;
  both/neither fail typed, explicit `--harness` skips inference, and
  gate-session v1 retains the result.
- A schema policy that binds the Nix daemon socket compiles `NIX_REMOTE=daemon`;
  an unbound policy does not.
- Codex UUID resume disables its inner approval and sandbox layers because the
  outer pagu box remains the enforcement boundary. Claude stays UUID-bound.

## Slice 8 shipped boundary

- Claude initial launches and approved relaunches use the exact
  `claude --resume UUID` adapter.
- The launcher retains cwd as exact evidence and reuses the Claude state bind
  for every box.
- Session/grant binding, TOCTOU checks, and once consumption remain in the
  harness-agnostic gate lifecycle.

## Slice 7 shipped boundary

- Gate-owned Codex launches bind `~/.codex`; Claude binds only `~/.claude` and
  `~/.claude.json`.
- The trusted harness overlay composes after profile/grant policy growth and
  before boundary validation and compilation, so initial and resumed boxes use
  the same authenticated state.
- Checked-in profiles remain immutable, final secret denies remain intact, and
  launch evidence reflects the effective bind.

## Slice 6 shipped boundary

- Six immutable schema-v0 category policies define advisor, worker, proof, web,
  infra, and orchestrator axes under `profiles/`.
- `pagu-box --profile NAME` and `pagu gate --profile NAME` resolve those
  artifacts without weakening the explicit `--policy` path or legacy names.
- Profile-wide assertions bind the secret floor, advisor read-only posture,
  journal exclusivity, Herdr control-plane concealment, and deny-last lowering.
- Versioned gate-session metadata and timestamps extend the canonical event log;
  the public telemetry-v0 SDK projects one or many logs into denial, approval,
  tier, and conservative prune-candidate queries.
- Human and JSON CLI output render the same projection. No flow dependency,
  syscall interception, automatic request generation, or automatic profile
  mutation is introduced.

## Slice 5 shipped boundary

Slice 5 turns a recorded approval into a new launch as one security lifecycle.

### Relaunch and resume

- Stop the denied attempt without widening the live mount namespace.
- Compile a complete derived grant into a new box launch.
- Resume through a typed adapter: Codex and Claude are UUID-bound.
- Record launch linkage and the exact compiled enforcement material.
- Fail secure when resume is unavailable: retain the grant and require an
  explicit fresh launch.

### Scope semantics

- `once` is durably consumed before spawn and cannot replay. A crash may
  conservatively spend it without a successful launch.
- `session` remains valid only for the gate session and policy identity that
  created it.
- `persist` remains a user-policy edit; it never writes project policy.
- A retained persist grant rebuilds a missing projection and completes an
  interrupted edit on restart.
- A child grant is derived from, and cannot exceed, its parent authority.

### TOCTOU hardening

- Canonicalize every filesystem grant immediately before compilation.
- Re-canonicalize stored grants and again after the previous sandbox stops;
  revalidate every policy root and reject a canonical target that changed.
- Bind the decision-time request, enforcement-time path, and launch event in
  retained evidence.

### Operator surface

- Keep the TTY fallback.
- Read the queue and submit an ID-bound resolution through the host-only SDK or
  `pagu resolve` adapter.
- Never mount herdr's control socket into the box.
- Route every surface through the existing Approver port.

## Homelab flake-input migration

Next:

1. point homelab at this repository's flake;
2. replace the archived standalone-box input with `pagu-box` from this flake;
3. remove text substitution used to customize the old launcher;
4. express worker policy as schema data;
5. verify nested delegation and a full request → decision → relaunch journey;
6. keep the compatibility executable until every caller moves to the unified
   command surface.

## Follow-on work

These items follow the complete Slice 5 lifecycle:

- full-policy denial classification and automatic request generation;
- complete relative-path, dirfd, symlink, rename-race, and syscall-family
  coverage for denial evidence;
- reviewed overlay-to-profile promotion and unused-allow pruning tooling;
- reconciliation UX for a once grant conservatively spent by a process crash;
- schema-v0 lowering for macOS seatbelt;
- a unified `pagu box` command while retaining the compatibility executable;
- grant listing and revocation UX over the retained derivation data;
- tested policy fixtures carried beside operator policies;
- optional flow integration above the standalone gate;
- domain-aware network policy and credential-injecting egress;
- per-launch Codex state-write isolation if mutually hostile concurrent fleet
  agents must be attribution-safe;
- an arbitrary-harness gate/resume port, if a concrete integration requires the
  larger lifecycle design beyond `pagu-box --evidence`;
- cryptographic discharge only if the boundary becomes multi-host.

## Archived direction

The former integrated harness and its workflow-SDK plan live on branch
`archive/harness` and tag `harness-final`. They are historical context, not a
parallel roadmap. Reopening that direction requires a concrete use case and a
new decision record.
