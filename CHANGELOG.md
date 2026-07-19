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

The gate currently records approval; it does not relaunch the sandbox with a
wider policy. Resume/relaunch and filesystem handoff safety are the next product
slice.

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
