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

| Slice                   | Outcome                                                                                                          | Status       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------ |
| 1 — consolidate         | Import the cross-platform `pagu-box` history and preserve its compatibility package.                             | ✓ shipped    |
| 2 — policy core         | Strict schema v0, bottom policy, grant shape, narrow-only project fold.                                          | ✓ shipped    |
| 3 — enforcement adapter | Pure Linux lowering, `--policy`, exact `--explain`, fail-loud unsupported platforms.                             | ✓ shipped    |
| 4 — gate MVP            | Typed append-and-await request channel; refuse/auto/operator tiers; once/session/persist state; retained events. | ✓ shipped    |
| docs rewrite            | Replace live harness-era documentation and re-arm documentation drift checks.                                    | ✓ shipped    |
| 5 — apply grants        | Relaunch/resume, operator/herdr surface, once consumption, session binding, enforcement-time canonicalization.   | ✓ shipped    |
| 6 — profiles/telemetry  | Six curated category policies, named resolution, CI assertions, and a standalone event-log telemetry projection. | ✓ shipped    |
| 7 — harness state       | Compose harness-scoped auth/session state into every gate-owned launch and relaunch.                             | ✓ shipped    |
| 8 — Claude resume       | Verify exact `claude --resume UUID` through the shared relaunch lifecycle.                                       | ✓ shipped    |
| 9 — profile hardening   | Infer the harness, restore Nix-daemon environment parity, and stand down inner Codex gating.                     | ✓ shipped    |
| 11 — denial spike       | Bound seccomp user-notif feasibility for one structured, supervisor-owned denial record.                        | pending      |
| homelab migration       | Consume this repository as the flake input; remove source patching and the old `pagu-box` input.                 | next         |

## Slice 11 feasibility boundary

- Linux seccomp user-notif is the preferred candidate shared with future
  block/ask; unprivileged viability awaits the lead's outside-box proof.
- The spike packages one exact-path supervisor denial and a unit-tested JSON
  record. The lead owns the real outside-box proof command.
- User-notif alone cannot passively observe the result after `CONTINUE`;
  policy-aware mediation/path resolution is a full security-boundary slice.
- `LD_PRELOAD` remains only a partial diagnostic fallback; kernel audit logging
  is disqualified by privileged collection.

## Slice 9 shipped boundary

- `pagu gate` infers Codex or Claude from exactly one matching session store;
  both/neither fail typed, explicit `--harness` skips inference, and
  gate-session v1 retains the result.
- A schema policy that binds the Nix daemon socket compiles
  `NIX_REMOTE=daemon`; an unbound policy does not.
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

- Six immutable schema-v0 category policies define advisor, worker, proof,
  web, infra, and orchestrator axes under `profiles/`.
- `pagu-box --profile NAME` and `pagu gate --profile NAME` resolve those
  artifacts without weakening the explicit `--policy` path or legacy names.
- Profile-wide assertions bind the secret floor, advisor read-only posture,
  journal exclusivity, Herdr control-plane concealment, and deny-last lowering.
- Versioned gate-session metadata and timestamps extend the canonical event
  log; the public telemetry-v0 SDK projects one or many logs into denial,
  approval, tier, and conservative prune-candidate queries.
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

- Linux structured denial evidence from the enforcement adapter;
- syscall-interception observation and automatic request generation;
- reviewed overlay-to-profile promotion and unused-allow pruning tooling;
- fresh-session creation/discovery so Codex need not start from an existing
  session UUID;
- reconciliation UX for a once grant conservatively spent by a process crash;
- schema-v0 lowering for macOS seatbelt;
- a unified `pagu box` command while retaining the compatibility executable;
- grant listing and revocation UX over the retained derivation data;
- tested policy fixtures carried beside operator policies;
- optional flow integration above the standalone gate;
- domain-aware network policy and credential-injecting egress;
- cryptographic discharge only if the boundary becomes multi-host.

## Archived direction

The former integrated harness and its workflow-SDK plan live on branch
`archive/harness` and tag `harness-final`. They are historical context, not a
parallel roadmap. Reopening that direction requires a concrete use case and a
new decision record.
