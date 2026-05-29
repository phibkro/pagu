# Linux VM environment — the coarse outer isolation tier (design)

> Status: **draft 2026-05-29** (brainstorm done → grill next). Sub-project **B**
> of pagu's test/demo environment (A demo fixture → **B Linux VM** → C scored
> eval). B wraps pagu in a reproducible Linux guest; A is the workload that runs
> _inside_ it, C scores runs _inside_ it.

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
reproducible Linux guest, plus the image build and snapshot/restore tooling. It
is **purely additive**: pagu's trusted core is untouched; inside the guest pagu
still runs its full tier-1 (Deno perms) + tier-2 (bwrap) per script. B is
wrapper + image + snapshot — not a change to the security core.

## Core decisions (settled in brainstorm)

1. **Scope** — one reproducible image, **two run-modes** (ephemeral for
   test/eval; persistent for deploy). Build the local/ephemeral path first.
2. **Boundary strength** — **tiered**, mirroring `detectSandbox`: a `detectVM`
   seam picks the strongest available runtime and **degrades to `none`** (=
   today's tier-1/2-only behavior — no regression). First concrete tier =
   **rootless Podman**; **Firecracker microVM** is a designed-but-deferred
   second tier on the same rootfs.
3. **Composition** — **purely additive outer layer**: the VM wraps pagu
   unchanged; tiers 1–2 stay exactly as they are (true nested defense in depth).
   The VM is _also_ the **snapshot/restore boundary**.
4. **What crosses the boundary:**
   - _Filesystem:_ only explicitly **threaded-in dirs** are mounted (Podman
     `--volume`; virtiofs on the Firecracker tier) — blast radius = the mounts.
   - _Network:_ `--network none` + **deny-all egress except the model host**;
     wider egress, when granted, routes through **Claw Patrol** (the
     credential-injecting egress proxy — so net-granted scripts never see raw
     secrets). Bundled-offline-model is a deferred optional mode.
5. **Image strategy** — one reproducible **base** + **minimal per-use-case
   variants**, so each image carries only its context's capabilities (smaller
   attack surface), sharing the base to avoid forking maintenance.

## Architecture — the `detectVM` tier

A new tier _outside_ the existing two, selected at the orchestrator boundary
before pagu does its work:

```
tier 3 (B):  detectVM → podman | firecracker(deferred) | none   ← wraps the whole process
tier 2:      detectSandbox → bwrap | sandbox-exec | none         ← per script (unchanged)
tier 1:      Deno --allow-* permissions                          ← per phase (unchanged)
```

- **Pure construction, effectful detection** — same shape as `sandbox.ts`: a
  pure `wrapForVM(kind, argv, scope)` builds the runtime command + args; an
  effectful `detectVM()` probes for an available runtime (memoized). `none` →
  the identity wrap (pagu runs exactly as today).
- **`VMScope`** (the threaded-through boundary, analogous to `SandboxScope`):
  `mounts` (host→guest dir pairs, the only fs the guest sees), `allowNet` (false
  by default; the model host is the lone allowlisted egress), `image` (the
  variant tag), `mode` (`ephemeral | persistent`).
- **Where it lives** — `src/vm/` (barrel `index.ts`): `detect.ts` (detection +
  tiers), `wrap.ts` (pure command construction), `image.ts` (build
  - variant selection), `snapshot.ts` (snapshot/restore). It does **not** import
    the security core; it composes _around_ it.

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

The **VM snapshot is the restore boundary** that A's out-of-envelope backup
tarball stood in for: snapshot before a run, restore to undo. On the Podman tier
this is a container checkpoint / committed image; on the Firecracker tier it is
a native VM snapshot.

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
- Ephemeral mode + the fs-mount / deny-all-egress-except-model scope.
- Snapshot/restore on the Podman tier.
- **Integration test:** A's `containment.test.ts` runs _inside_ the Podman guest
  and asserts the same structural guarantees hold through the outer layer;
  `detectVM === none` skips (like A's tier-`none` skip).

**Deferred (designed, not built):**

- **Firecracker microVM tier** — the hardware wall, on the same rootfs (virtiofs
  - native snapshot); added where the host has KVM.
- **Persistent / remote-deploy mode + the remote-drive transport** — how an
  operator talks to pagu in a remote guest (ACP over a transport? an audited
  control channel?). **Needs its own design** — flagged, not solved here.
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

## Open questions for grill

- Does **rootless Podman** give a strong enough fs/net boundary for the `local`
  tier, or should the first concrete tier be `systemd-nspawn` on systemd hosts?
  (Trade: Podman portability/reproducibility vs nspawn fewer-deps.)
- **Snapshot semantics on Podman** — checkpoint (CRIU, live state) vs commit
  (image only). Which is the honest "restore boundary" for an ephemeral run?
- Does the deny-all-egress-except-model boundary belong at the **VM layer**, or
  is it already covered by pagu's per-script net policy inside the guest (and B
  just enforces it coarsely as defense in depth)?
- The **remote-drive transport** is deferred — but does deferring it leave the
  `local`-first cut genuinely useful on its own (for A + C)? (Believed yes.)
