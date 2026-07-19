---
summary: "Forward plan for pagu's box + gate product, ordered by delivery slice."
tags: [roadmap, planning]
---

# pagu — roadmap

The live product is the box + gate pair defined by
[ADR-0004](docs/decisions/0004-pivot-to-sandbox-plus-gate.md) and
[ADR-0005](docs/decisions/0005-grant-schema-and-gate-boundary.md).
[CONTEXT.md](CONTEXT.md) owns durable design; this file owns sequence and
remaining work.

## Delivery slices

| Slice                   | Outcome                                                                                                          | Status        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------- |
| 1 — consolidate         | Import the cross-platform `pagu-box` history and preserve its compatibility package.                             | ✓ shipped     |
| 2 — policy core         | Strict schema v0, bottom policy, grant shape, narrow-only project fold.                                          | ✓ shipped     |
| 3 — enforcement adapter | Pure Linux lowering, `--policy`, exact `--explain`, fail-loud unsupported platforms.                             | ✓ shipped     |
| 4 — gate MVP            | Typed append-and-await request channel; refuse/auto/operator tiers; once/session/persist state; retained events. | ✓ shipped     |
| docs rewrite            | Replace live harness-era documentation and re-arm documentation drift checks.                                    | ✓ this slice  |
| 5 — apply grants        | Relaunch/resume, operator/herdr surface, once consumption, session binding, enforcement-time canonicalization.   | next          |
| homelab migration       | Consume this repository as the flake input; remove source patching and the old `pagu-box` input.                 | after Slice 5 |

## Slice 5 acceptance boundary

Slice 5 turns a recorded approval into a new launch. It must ship as one
security lifecycle, not independent conveniences.

### Relaunch and resume

- Stop the denied attempt without widening the live mount namespace.
- Compile a complete derived grant into a new box launch.
- Resume the harness through an explicit adapter when that harness supports a
  stable resume identifier.
- Record launch linkage and the exact compiled enforcement material.
- Fail secure when resume is unavailable: retain the grant and require an
  explicit fresh launch.

### Scope semantics

- `once` is consumed by one successful relaunch attempt and cannot replay.
- `session` remains valid only for the gate session and policy identity that
  created it.
- `persist` remains a user-policy edit; it never writes project policy.
- A child grant is derived from, and cannot exceed, its parent authority.

### TOCTOU hardening

- Canonicalize every filesystem grant immediately before compilation.
- Reject a path whose canonical target moved outside its approved parent.
- Bind the decision-time request, enforcement-time path, and launch event in
  retained evidence.

### Operator surface

- Keep the TTY fallback.
- Add a read-only queue rendering and resolution adapter for herdr.
- Never mount herdr's control socket into the box.
- Route every surface through the existing Approver port.

## Homelab flake-input migration

After Slice 5 is accepted:

1. point homelab at this repository's flake;
2. replace the archived standalone-box input with `pagu-box` from this flake;
3. remove text substitution used to customize the old launcher;
4. express worker policy as schema data;
5. verify nested delegation and a full request → decision → relaunch journey;
6. keep the compatibility executable until every caller moves to the unified
   command surface.

## Follow-on work

These items are deliberately behind the complete Slice 5 lifecycle:

- Linux structured denial and launch evidence from the enforcement adapter;
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
