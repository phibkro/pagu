# Linux VM environment — the coarse outer isolation tier (design)

> Status: **hardened 2026-05-29** (brainstorm → grill → tdd-ready). Sub-project
> **B** of pagu's test/demo environment (A demo fixture → **B Linux VM** → C
> scored eval). B wraps pagu in a reproducible Linux guest; A is the workload
> that runs _inside_ it, C scores runs _inside_ it.

## The vision this serves

pagu's intended goal: **safely give an agent access to personal homelabs and
critical infrastructure** — operate on _real working servers_, not a disposable
remote sandbox. A proved the per-process containment (tiers 1–2). B adds a
**coarser outer wall around the whole pagu process** so pagu can be _deployed_
onto real infra (and exercised in test/eval) with a statically enumerable blast
radius at the machine boundary too — defense in depth, and the restorable outer
boundary that A's backup tarball stood in for.

## What B is

A new **outer isolation tier** that wraps an entire pagu invocation in a
reproducible Linux guest, plus the image build tooling. It is **purely
additive**: pagu's trusted core is untouched; inside the guest pagu still runs
its full tier-1 (Deno perms) + tier-2 (bwrap) per script. B is launcher + image
— not a change to the security core. (Snapshot/restore tooling is a deferred
persistent-mode concern — ephemeral restore is just recreate-from-image.)

## Core decisions (settled in brainstorm)

1. **Scope** — one reproducible image, **two run-modes** (ephemeral for
   test/eval; persistent for deploy). Build the local/ephemeral path first.
2. **Boundary strength** — **tiered**, mirroring `detectSandbox`: a `detectVM`
   seam picks the strongest available runtime and **degrades to `none`** (=
   today's tier-1/2-only behavior — no regression). First concrete tier =
   **rootless Podman**; **Firecracker microVM** is a designed-but-deferred
   second tier on the same rootfs.
3. **Composition** — additive outer layer; **tier-1 (Deno perms) unchanged
   in-guest**. _Tier-2 revised by an impl finding (below):_ `bwrap` **cannot
   nest** in a rootless container, so in-guest tier-2 = `none` and the
   **container is tier-2's replacement** for write/net confinement; read
   concealment moves to the **launcher's mount layer**. The VM is _also_ the
   **restore boundary** (recreate-from-image for ephemeral; real
   snapshot/restore deferred to persistent mode).
4. **What crosses the boundary:**
   - _Filesystem:_ only explicitly **threaded-in dirs** are mounted (Podman
     `--volume`; virtiofs on the Firecracker tier) — blast radius = the mounts.
   - _Network:_ the guest needs egress **to the model host** (pagu's `respond`
     phase makes the provider HTTP call inside the guest), so the boundary is
     **model-host-only egress** — a restricted Podman network + an egress
     allowlist (pinned gateway / firewall to the model endpoint), **not**
     `--network none`. The default `local` model is **host-side** (e.g. Ollama
     on the host); `--network none` is reserved for the deferred bundled-offline
     mode (model in the guest). Wider egress, when granted, routes through
     **Claw Patrol** (the credential-injecting egress proxy — so net-granted
     scripts never see raw secrets).
5. **Image strategy** — one reproducible **base** + **minimal per-use-case
   variants**, so each image carries only its context's capabilities (smaller
   attack surface), sharing the base to avoid forking maintenance.

## Architecture — a host-side launcher, NOT an in-loop tier

**Code-reality correction (grill 2026-05-29).** B wraps the _whole pagu
process_, which is the **opposite direction** from `detectSandbox`: today the
runner spawns a sandboxed **child** `deno run` (`run.ts` → `wrapForSandbox` →
`Deno.Command(...).spawn()`), so the sandbox wraps a child _of_ pagu. B's
wrapper must therefore live **outside** pagu and **re-exec it inside the guest**
— it cannot be a module inside the agent loop wrapping the binary that contains
it. So B is a **host-side launcher**, not an in-loop tier.

```
host launcher (B):  pagu vm <task>  → detectVM → podman | firecracker(deferred) | none
                       └─ podman run --volume <dirs> --egress=<model-host-only>  pagu-image  pagu <task>
                                                                                    │
  ───────────────────────────────── guest boundary ───────────────────────────────┤
  pagu (inside guest, runs exactly as today; detectVM === none → no recursion)      │
    tier 2:  detectSandbox → bwrap | none      ← per script (unchanged)             │
    tier 1:  Deno --allow-* permissions        ← per phase (unchanged)             │
```

- **The launcher = a `pagu vm <task>` subcommand** (host side), handled in the
  CLI frontend before the normal flow (like `completions` / `--acp` today). It
  does `detectVM` + builds the wrap + `podman run`s the image with `pagu <task>`
  as the guest entrypoint. It is **not** part of `runTask` / the agent loop.
- **Recursion guard** — pagu _inside_ the guest must see **`detectVM === none`**
  so it never wraps again. The launcher sets an env marker (e.g.
  `PAGU_IN_VM=1`); `detectVM()` returns `none` when it's set. Without the guard,
  a guest with a container runtime would nest forever.
- **Pure construction, effectful detection** — the `detectSandbox` _code shape_
  still applies to the launcher: a pure `wrapForVM(kind, argv, scope)` builds
  the runtime command + args; an effectful `detectVM()` probes for a runtime
  (memoized) and honors the recursion guard. `none` → run `pagu <task>` directly
  on the host (exactly as today — no regression).
- **`VMScope`** (the threaded-through boundary, analogous to `SandboxScope`):
  `mounts` (host→guest dir pairs, the only fs the guest sees), `egress` (the
  allowlisted destinations — the model host by default; `[]` only in
  bundled-offline mode → `--network none`), `image` (the variant tag), `mode`
  (`ephemeral | persistent`).
- **Where it lives** — `src/vm/` (barrel `index.ts`): `detect.ts` (detection +
  recursion guard), `wrap.ts` (pure command construction), `image.ts` (build and
  variant selection), `snapshot.ts` (snapshot/restore). The `pagu vm` subcommand
  in the CLI frontend calls into it. `src/vm/` does **not** import the security
  core; it composes _around_ it, on the host.

## The image — one base, pruned variants

A `Containerfile` (OCI, built by Podman/Docker; the portable lingua franca)
produces a minimal **base**: Deno + pagu + bwrap, nothing else. Variants layer
on and carry _only_ their context's surface:

- **`local`** (test/eval/dev) — A's fixture tooling, optional bundled offline
  model; **no** remote-access surface. The first cut targets this variant.
- **`remote-deploy`** — the remote-drive path + audit shipping; **no** dev/test
  tooling. (Deferred — needs the transport design below.)
- **personal vs enterprise** — differ in **policy defaults** (egress posture,
  Claw Patrol presence, audit log shipping), _not_ core binaries.

All variants share the reproducible base; each is a least-privilege capability
set. Reproducibility is solved once (the base) and reused by every mode + tier.

## Run-modes + the restore boundary

Same image, two modes:

- **Ephemeral** — spin up → run → discard. A's golden-scenario fixture and C's
  eval run _inside_ an ephemeral guest; the guest itself is the throwaway
  boundary (no leftover state).
- **Persistent** — a long-lived guest as the deploy vessel on real infra.

The **restore boundary** is what A's out-of-envelope backup tarball stood in for
— but it differs by mode:

- **Ephemeral:** the image _is_ the clean state, so restore = **discard +
  recreate from the pristine image**. No snapshot tooling. This is all A + C
  need.
- **Persistent (deferred):** a long-lived guest needs real rollback — Podman
  `checkpoint`/`commit` (or a native VM snapshot on the Firecracker tier). The
  checkpoint-vs-commit choice is made when persistent mode is designed.

## How B relates to A and C

- **A:** B is where A's `setup.ts` + runner run _inside_ the guest. A's
  containment guarantees must hold _through_ the extra layer; B's restore
  boundary supersedes A's tarball stand-in.
- **C:** the scored eval runs inside an ephemeral guest per scenario — clean
  state per run, and the guest is the blast-radius wall while a real (possibly
  adversarially-framed) model drives.

## Invariants exercised / respected

- **#5 (runs anywhere, minimal deps, offline-capable)** — the load-bearing
  constraint. `detectVM` degrading to `none` is what preserves it: B is **never
  a hard requirement**; on a host without a container runtime pagu runs exactly
  as today. Rootless Podman keeps the first tier low-trust; the OCI image is
  portable; bundled-offline-model (deferred) serves the air-gapped case.
- **#1 / #2 (no agent exec path; perms are the boundary)** — untouched. B adds
  an _outer_ wall; it does not hand the agent any capability, and the per-script
  Deno+OS boundary inside the guest is unchanged.
- **Minimal trusted core** — B composes _around_ the core; `src/vm/` imports no
  security-core module.

## First implementation cut vs deferred

**First cut (this spec's TDD target):**

- `src/vm/` with the `detectVM` seam + pure `wrapForVM` (Podman + `none` tiers).
- The base image + the `local` variant (`Containerfile` + build script).
- Ephemeral mode + the `VMScope` (threaded fs mounts + model-host-only egress).
  Restore for ephemeral = **discard + recreate from the pristine image** (the
  image _is_ the clean state) — no snapshot tooling needed.
- **Integration test (shape A — host-side):** a `Deno.test` on the host
  `podman run`s the `local` image with a fresh fixture mounted + the host-side
  mock provider's `localhost:<port>` wired into `VMScope.egress` (**the mock
  _is_ the allowlisted model host**); a small in-guest entrypoint runs A's
  scenario and reports results out (exit/stdout); the host asserts the
  guarantees held through the outer layer. Skips at `detectVM === none` (so it
  runs only where Podman is installed — same skip pattern as A's tier-`none`, a
  new CI host dep).

**Deferred (designed, not built):**

- **Firecracker microVM tier** — the hardware wall, on the same rootfs (virtiofs
  mounts and native snapshot); added where the host has KVM.
- **Persistent / remote-deploy mode + the remote-drive transport** — how an
  operator talks to pagu in a remote guest (ACP over a transport? an audited
  control channel?). **Needs its own design** — flagged, not solved here.
- **Snapshot/restore (persistent mode only)** — for a long-lived guest you want
  to roll back without rebuilding: Podman `checkpoint` (CRIU, live process
  state) vs `commit` (dirty→image). The checkpoint-vs-commit choice is decided
  when persistent mode is designed; ephemeral runs don't need it.
- **Bundled-offline-model mode** (the `local` air-gapped variant add-on).
- **Enterprise audit shipping** + the personal/enterprise policy-default split.
- macOS/Windows hosts — Linux guest first.

## Testing

Integration/enforcement is the test level (real runtime + real mounts + real net
denial, via the public CLI/`mod.ts`), not mocks: assert pagu runs inside the
guest, that only threaded dirs are visible, that egress beyond the model host is
denied, and that A's golden scenario keeps all its guarantees through the layer.
Pure `wrapForVM` gets unit tests (the command-construction law). Skips cleanly
at `detectVM === none`.

## Resolved in grill (2026-05-29)

- **Invocation site** — B is a **host-side launcher / `pagu vm` subcommand**
  that re-execs pagu inside the guest, _not_ an in-loop tier (it wraps the whole
  process, the opposite direction from `detectSandbox`). Recursion guard:
  pagu-in-guest sees `detectVM === none` via an env marker.
- **Network** — `--network none` + "except model" was contradictory and would
  break the in-guest model call. Resolved: **model-host-only egress** for the
  default `local` variant (host-side model); `--network none` only in the
  deferred bundled-offline mode.
- **Egress layer** — the VM enforces model-host-only egress **coarsely as
  defense in depth**; pagu's per-script net policy inside the guest is
  **unchanged** and still the fine-grained control. They compose (outer coarse +
  inner fine), they don't conflict.
- **Snapshot** — not in the first cut. Ephemeral restore = recreate from the
  pristine image; real snapshot/restore is a **persistent-mode** concern
  (deferred), where checkpoint-vs-commit gets decided.
- **First tier** — **rootless Podman** (Approach 1): OCI reproducibility +
  low-trust + a clean path to the Firecracker tier. `systemd-nspawn` not chosen
  (Linux+systemd-only, weaker "runs anywhere").
- **Transport deferral** — deferring the remote-drive transport leaves the
  `local`-first cut **genuinely useful on its own** (it's exactly what A + C
  consume); confirmed.

## Implementation findings (2026-05-29)

- **`bwrap` cannot nest in rootless Podman** (verified: "Creating new namespace
  failed: Operation not permitted", even with `seccomp=unconfined` +
  `unmask=ALL`). So tier-2 can't run in-guest. Resolution (shipped):
  - The guest image **does not install bwrap** → in-guest `detectSandbox`
    returns `none` cleanly (rather than falsely selecting bwrap then failing at
    runtime). The **container replaces tier-2** for write confinement (only
    `/work` mounted) + net confinement (egress policy).
  - **Read concealment moves to the launcher's mount layer** — concealed paths
    (`.env`, secrets) are simply **not threaded into the guest** (or bound to
    `/dev/null`), so the secret never enters the guest. This preserves A's
    guarantee (1) without nested bwrap. _(Mount-layer masking + the
    exfil-in-guest test still to implement — see status below.)_
- **Validated live** (`nix shell nixpkgs#podman`): pagu runs in the `pagu:local`
  guest, drives the mock model, and A's **destruction** scenario is contained to
  the mounted `/work` — the out-of-mount sentinel/backup are untouched and
  restore recovers (`containment_vm.test.ts`).

## Status (2026-05-29)

**Shipped:** `src/vm/` (`detectVM` + recursion guard, pure `wrapForVM`,
`planVMLaunch`, `modelHostFromBaseURL`; all unit-tested) · `vm/Containerfile`
(base + `local`, no bwrap) · `containment_vm.test.ts` (destruction-in-guest,
skips at `detectVM === none`).

**Remaining for the first cut:**

- **Mount-layer concealment** — the launcher applies the concealment policy to
  the threaded mounts (don't mount concealed paths / bind `/dev/null`), then the
  **exfil-in-guest** test asserting the canary stays masked through the layer.
- **`pagu vm` subcommand** — wire `detectVM` + `planVMLaunch` + `wrapForVM` +
  spawn in the CLI frontend (currently the test drives `podman` directly).
- **Egress-allowlist mechanism** — replace the test's `--network=host` smoke
  with model-host-only egress (restricted Podman network + firewall vs
  `pasta`/slirp single-destination vs pinned gateway); the enforcement test is
  the proof.
