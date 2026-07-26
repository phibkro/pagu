---
summary: "Pre-v1 history of the box-and-gate product; the commit log remains authoritative."
tags: [changelog, history]
---

# Changelog

pagu is pre-v1 and has no release ledger yet. This is the human-readable shipped
history; the Conventional Commit log is authoritative, and `ROADMAP.md` contains
only forward work.

## Box enforcement

- Fixed `fatal: not a git repository: (null)` when a journey is launched from a
  Git linked worktree. A linked worktree's `.git` is a pointer file, so the
  repository lives outside every `$PWD`-scoped mount. `src/policy/worktree.ts`
  now derives the exact metadata mounts from repository facts that are probed,
  validated, and frozen before bubblewrap starts.
- Bounded that derivation instead of widening the box: the access mode mirrors
  the profile's authority on the launch directory, the Git common root stays
  read-only, and only the object store, ref store, common reflog directory, and
  this worktree's own administrative directory become writable — parents first,
  so a writable child overlays the read-only parent. `git config --local`,
  `pack-refs`, `gc`, `repack`, `worktree add/prune`, and `FETCH_HEAD` writes stay
  refused.
- Made repository pointers prove themselves rather than be believed: the
  administrative directory must carry the `gitdir` back pointer naming this
  worktree, `commondir` must resolve to the exact parent of `worktrees/<name>`,
  and every derived path must sit inside a trusted root the trusted policy layer
  already names and inside no denied root. Traversal, symlink aliases, rewritten
  `commondir` values, submodules, and `--separate-git-dir` layouts are refused
  before launch with stable diagnostics; ordinary checkouts and bare repositories
  are unchanged.
- Added `deno task journey:worktree`, a real bubblewrap journey over the shipped
  advisor and worker profiles: writer status/stage/commit with packed refs and
  reflog, advisor refused at the index, refs, objects, and reflog, and both a
  forged and a genuine-but-untrusted pointer refused before launch.

## Product launch surface

- Changed the launch grammar so a launch names its harness: `pagu claude`,
  `pagu codex`, `pagu pi`, or a path whose basename infers one. `--` is now
  reserved for executables that would otherwise parse as an option, and bare
  `pagu` prints usage instead of launching a guessed adapter. Configured
  `launch.json` defaults still complete any otherwise-stated launch. Supersedes
  the bare-launch and `--`-separated forms below (ADR-0013).
- Pointed the failure modes at the tool that fits: wrapping a command with
  arguments, or an executable no adapter recognizes, now names `pagu box` and
  quotes the caller's own argv as a runnable line.
- Moved argv tokenisation to `@std/cli` while keeping every policy-selecting
  decision hand-owned. `--harness` is validated on both parse paths, and
  `--deny` beats an approval scope regardless of argument order.
- Made the packaged CLI hermetic: `vendor/` is committed and shipped into the
  Nix store, and `--cached-only` fails a missing module loudly at launch rather
  than fetching it over the network inside a process holding `--allow-net
  --allow-write --allow-run`.
- Made bare `pagu` start a fresh gate-owned worker Codex session and made `pagu`
  the root flake's default package. The direct `pagu gate` and compatibility
  `pagu-box` surfaces remain available.
- Added strict, versioned user launch defaults in XDG `pagu/launch.json`. The
  file may select one checked-in category and verified Codex/Claude adapter;
  absence uses built-in defaults and malformed or unknown fields fail before
  launch.
- Added typed SDK functions for launch-config decoding/discovery, harness
  inference, and launch resolution. `pagu -- EXECUTABLE` infers a recognized
  Codex/Claude basename, while an opaque wrapper requires `--harness`.
- Reoriented forward delivery around actor-named end-to-end tracer journeys,
  with MCP/skill access and monotone nested authority as the next slices.
- Added a dependency-free Deno stdio MCP server with one strict
  `request_read_access` tool over the existing request socket. Gate-owned Codex
  and Claude sessions receive it through transient launch/resume arguments;
  persistent harness configuration is unchanged.
- Updated the bundled pagu skill for MCP discovery, exact-path request
  semantics, and the approval-triggered disconnect/resume lifecycle. Operator
  resolution and gate state remain host-only.
- Expanded the bundled pagu skill into a provider-neutral operating guide for
  host and inhabitant agents: default launch, profiles, trusted configuration,
  direct-box inspection, exact read requests, host resolution, and nested
  boundary limits now share one concise workflow.
- Added strict child-policy derivation and relative actor/box lineage to the
  public SDK. Child identity may change, while filesystem, home, network,
  environment, auto-escalation, deny, and refusal authority can only attenuate
  from the effective parent.
- Proved two real bubblewrap levels with an accepted child and an API-bypass
  widening attempt. Ordinary child work succeeds, while outer filesystem,
  network, environment, gate state, and control removals remain final.
- Recorded the trusted nested-lifecycle boundary in ADR-0010. Lineage-attributed
  child requests, replacement, and launch-chain evidence remain deferred to a
  narrow outside broker; no general control socket was introduced.
- Accepted ADR-0011 and shipped child-lifecycle phase A: one strict
  `launch-child` frame, sender-namespace-selected recursive authority,
  transactional rollback, and versioned lineage-linked launch evidence.
- Added a real host-owned tracer that enters the exact parent namespaces,
  launches the packaged box from immutable inline policy, verifies the nested
  namespace result, performs ordinary child work, and commits its compiled
  material to the outside append-only event log.
- Added internal Linux inline-policy and stdio-evidence adapter seams for the
  trusted nested launcher. Darwin rejects them explicitly; the native
  per-message credential/PIDFD frontend, inhabitant adapter, and child
  request/replacement path remain deferred.
- Added a provider-free packaged journey tracer. A deterministic
  Codex-compatible inhabitant uses the injected Pagu MCP server to request one
  initially unavailable fixture; the host resolves it through `pagu resolve`,
  and the tracer verifies first-box replacement, exact-session resume, the
  retained policy transition, and final access with zero model calls.
- Added `pagu box` as the human direct-enforcement surface while retaining
  `pagu-box` as an exact compatibility executable. Dispatch occurs before the
  root wrapper changes `PATH`; a packaged tracer compares help, schema
  explanation, and a real child-visible launch under both names.
- Added Pi as a verified launch adapter with basename/config/session-store
  inference, caller-assigned fresh UUIDs, exact `--session` reopening, and
  scoped `~/.pi` state. Common user-local Pi package roots are visible
  read-only, while final policy denies remain unchanged.
- Added an immutable Pi-native `request_read_access` extension and explicit
  pagu skill injection on both fresh and resume commands. The extension invokes
  the same packaged request-only MCP adapter rather than duplicating the request
  protocol or editing persistent Pi configuration.
- Verified a fresh packaged Pi 0.80.6 box and a second exact-UUID resume box
  against local Ollama `qwen3.5:9b`; both reported the native request tool
  present, with hosted-provider variables removed from the journey.

## Box and gate foundation

- Archived the earlier integrated assistant product on its preservation branch
  and tag before changing the product boundary.
- Consolidated the imported Nix sandbox as the `pagu-box` package and CLI. Linux
  uses bubblewrap; macOS retains the legacy profile interface while schema
  compilation remains unsupported there.
- Added strict schema-v0 decoding, a compositional policy algebra, built-in
  refusal rules, and narrow-only user/project policy loading in `src/policy/`.
- Published strict JSON Schema contracts for the complete `PolicyV0` profile
  grant accepted by `pagu-box --policy` and the distinct gate-derived `GrantV0`,
  with stable SDK identifiers and package exports; semantic validation remains
  in `parsePolicy` and `parseGrant`.
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
- Composed `~/.codex` RW state into every gate-owned Codex launch and relaunch,
  retaining final secret denies and exact compiled evidence. Claude receives
  only `~/.claude` and `~/.claude.json`.
- Added typed UUID resume adapters for Codex and Claude. Codex's inner approval
  and sandbox layers stand down because the outer box is the boundary; other
  explicit harness names fail loud.
- Made `--harness` optional by requiring exactly one matching Codex or Claude
  session store, retaining the result in gate-session v1 evidence. Explicit
  selection skips discovery; ambiguous and missing sessions fail typed.
- Restored legacy parity by compiling `NIX_REMOTE=daemon` exactly when a schema
  policy binds the Nix daemon socket, including the explanation projection.
- Bound grants to the exact session and authoritative/decision policy hashes;
  re-canonicalized paths at application; made once grants non-replayable.
- Added TTY plus host-only queue/resolution adapters over one Approver port in
  `src/gate/operator.ts`. The sandbox request protocol remains append-only.
- Added retained launch/failure/spend events and exact post-spawn box evidence.
- Added fresh gate-owned Codex/Claude launch. Codex binds the new rollout that
  contains its generated prompt nonce while ignoring concurrent decoys; Claude
  binds a caller-assigned `--session-id`. Gate-session v2 retains that UUID and
  widening resumes it.
- Verified the packaged fresh Codex lifecycle with a concurrently created decoy:
  nonce attribution selected the intended UUID, a boxed request was approved
  through the host adapter, the widened launch resumed that UUID, and the
  resumed model recalled its original nonce marker.
- Accepted cooperative concurrent peers as the Slice 13 threat boundary and
  deferred hostile shared-store isolation. Retained `pagu-box --evidence` as the
  supported adapter while deferring a general arbitrary-harness gate/resume
  port.
- Versioned box launch evidence as v1 when cwd became part of the exact launch.
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

## Category profiles and telemetry

- Added six checked-in schema-v0 category policies—advisor, worker, proof, web,
  infra, and orchestrator—with a shared secret refusal floor and safe session
  auto seeds.
- Added named category resolution to `pagu-box` and `pagu gate` while retaining
  explicit `--policy` and the four legacy compatibility profiles.
- Added CI assertions for advisor read-only behavior, journal exclusivity, Herdr
  control-plane concealment, and deny-last compiled mounts.
- Added versioned gate-session metadata and timestamped gate evidence, then
  exposed a standalone telemetry-v0 SDK/CLI projection with human and JSON
  denial, approval, tier, and conservative prune-candidate views.
- Spiked unprivileged seccomp user-notif with a packaged one-path denial helper
  and unit-tested JSON record; the outside-box capture was lead-verified.
- Promoted that substrate into opt-in Linux `--observe-denials`: the policy
  adapter derives exact/subtree rules from its compiled `fs.deny`, rejects logs
  below sandbox-writable roots, and appends strict denial-evidence v1 JSONL.
  Full-policy/path-race coverage and automatic requests remain deferred.
- Verified the packaged observer outside a box: a worker secret denial and a
  custom compiled `/etc/hosts` deny each emitted one v1 `openat` record, while
  an allowed `/etc/hosts` probe emitted no record.

See `README.md` for current use, `CONTEXT.md` for the trust model, and
`ROADMAP.md` for planned work.
