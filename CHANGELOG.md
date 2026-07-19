---
summary: "Pre-v1 history of the box-and-gate product; the commit log remains authoritative."
tags: [changelog, history]
---

# Changelog

pagu is pre-v1 and has no release ledger yet. This is the human-readable shipped
history; the Conventional Commit log is authoritative, and `ROADMAP.md` contains
only forward work.

## Box and gate foundation

- Archived the earlier integrated assistant product on its preservation branch
  and tag before changing the product boundary.
- Consolidated the imported Nix sandbox as the `pagu-box` package and CLI. Linux
  uses bubblewrap; macOS retains the legacy profile interface while schema
  compilation remains unsupported there.
- Added strict schema-v0 decoding, a compositional policy algebra, built-in
  refusal rules, and narrow-only user/project policy loading in `src/policy/`.
- Added Linux policy compilation to bubblewrap arguments. `--explain` is derived
  from the same compiled argument vector used for launch.
- Added the outside `pagu gate` authority in `src/gate/cli.ts`, backed by strict
  request and resolution messages, refuse/auto/operator tiers,
  once/session/persist scopes, and append-only request/decision/grant events in
  `src/request/`.
- Added the sandbox-side `fileRequest` SDK. The endpoint can submit and await a
  decision but cannot resolve its own request.

## Grant application and operator surface

- Made the gate own the boxed child and apply approvals only by stopping it,
  compiling a complete policy, and resuming the same Codex session.
- Added a typed resume-adapter port: verified Codex argv and fail-loud,
  not-yet-verified Claude behavior in `src/gate/resume.ts`.
- Bound grants to the exact session and authoritative/decision policy hashes;
  re-canonicalized paths at application; made once grants non-replayable.
- Added TTY plus host-only queue/resolution adapters over one Approver port in
  `src/gate/operator.ts`. The sandbox request protocol remains append-only.
- Added retained launch/failure/spend events and exact post-spawn box evidence.
- Enforced that gate state/socket stay outside sandbox mounts and the standing
  policy stays non-writable; the same proof reruns after the old sandbox stops.
- Required private, owned, non-replaceable operator state and made persist
  intent crash-recoverable; prepared launches remain tracked through rollback.
- Rechecked canonical targets after the old sandbox stops and on gate restart;
  Linux boxes stop when their owning gate process disappears.

## Documentation realignment

- Rebased the live documentation on the enforcement-point / policy-authority
  architecture recorded by
  [`ADR-0004`](docs/decisions/0004-pivot-to-sandbox-plus-gate.md) and
  [`ADR-0005`](docs/decisions/0005-grant-schema-and-gate-boundary.md).
- Classified older specifications and diagrams as pre-pivot history rather than
  descriptions of current runtime behavior.
- Restored documentation drift checking to the full CI gate while keeping
  immutable ADR path references as historical evidence.

See `README.md` for current use, `CONTEXT.md` for the trust model, and
`ROADMAP.md` for planned work.
