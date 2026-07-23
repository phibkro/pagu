# Runtime reload — frozen design specification

> Status: **frozen and manager-approved 2026-07-23**. Implementation is
> authorized only through the eight falsifier-bound slices below. The companion
> decision record is [`ADR-0007`](decisions/0007-runtime-reload.md).

## Goal

Make the high-iteration gate reloadable without terminating its boxes, then use
pagu's existing stop → recompile → relaunch → resume lifecycle for deliberate
box policy reloads.

The two operations are intentionally different:

| Operation               | Trigger                                | Process result                                                                   | Authority result                             |
| ----------------------- | -------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| gate config/tier reload | trusted data changes                   | same gate process and FDs                                                        | atomically adopt validated data for new work |
| gate binary reload      | operator starts a successor generation | successor adopts state and live FDs; existing box PIDs do not change             | no policy or grant change                    |
| box policy reload       | a trusted policy source changes        | wait for a verified safe point, then replace the box and resume the same session | apply exactly one validated complete policy  |

A graceful gate reload is not crash recovery. During the handoff the old
generation remains healthy and authoritative until the successor is committed.
Unexpected loss of the active generation remains fail-secure and may stop boxes.

## Non-goals

- no live mount-namespace widening;
- no general control socket inside a sandbox;
- no arbitrary-harness gate/resume port (the existing Codex/Claude boundary
  remains in force);
- no hot patching a running `pagu-box`, bubblewrap, or seccomp filter;
- no homelab deployment or rebuild;
- no claim that an arbitrary process can be stopped at a userspace-safe point;
- no high-availability or multi-host authority protocol.

## Current constraints that shape the design

1. Gate state and policy authority stay outside sandbox-visible/writeable roots.
2. The event log is retained truth; queue and grant JSON files are projections.
3. The current box adapter watches the launching gate PID and stops the sandbox
   when that PID exits. A reloadable session therefore needs a stable lifecycle
   guardian; merely forking a successor gate would kill existing boxes when the
   old gate exits.
4. A mounted Unix socket names the bound socket object, not its later pathname.
   Rebinding `request.sock` cannot update boxes already carrying the old mount.
   The existing listening FD must survive.
5. A seccomp user-notification listener belongs to a filter and may be passed by
   FD, but user-space work already received from it is not automatically
   re-delivered to another reader. The handoff protocol must account for those
   notification IDs explicitly.

## Target process topology

```text
trusted host

  stable lifecycle guardian (one per gate session)
    ├── owns box child lifecycle and the liveness identity seen by pagu-box
    ├── retains duplicate request/seccomp/log FDs during graceful handoff
    └── admits exactly one active gate-writer generation
          │
          ├── gate generation N (active, then quiescing)
          └── gate generation N+1 (validating, then active)

  sandbox (PID and mount namespace unchanged during gate reload)
    └── harness ── mounted request socket object ──► retained listener FD
```

The guardian is a narrow host-only adapter, not another adjudicator. It cannot
parse requests, decide tiers, derive grants, edit policy, or classify denial
paths. Its authority is limited to child liveness, generation fencing, and
holding/passing already-authorized FDs. Its control endpoint is private gate
state and is never mounted into a box.

Sessions launched before guardian support require one ordinary
stop/relaunch/resume to enter the reloadable topology. The design does not
pretend to preserve those legacy box PIDs.

## Generation and checkpoint model

Every reloadable gate run has a monotonically increasing `generation`. A frozen
handoff checkpoint contains:

```ts
interface GateReloadCheckpointV0 {
  readonly version: 0;
  readonly session: string;
  readonly harness: "codex" | "claude";
  readonly generation: number;
  readonly priorGeneration: number;
  readonly eventOffset: number;
  readonly eventDigest: string;
  readonly authoritativePolicyHash: string;
  readonly effectivePolicyHash: string;
  readonly activeLaunch: string;
  readonly pendingRequests: readonly PendingRequestHandoffV0[];
  readonly appliedGrantIds: readonly string[];
  readonly spentOnceGrantIds: readonly string[];
  readonly fdManifest: readonly ReloadFdV0[];
}
```

The exact wire shape must be versioned and strict when implemented. The event
log is replayed through `eventOffset`; projection files are checked against the
replay and rebuilt if absent or stale. A JSON projection can never override the
log. Session, harness, policy hashes, grant bindings, launch evidence, and
monotonic IDs must all agree before a successor can become active.

The successor opens state through the existing ownership/ancestry checks and
then re-runs the complete operator boundary proof. A changed canonical state,
policy, or socket path aborts handoff while generation N remains active.

## Data reload: config and tiers

A data reload does not start a process or transfer an FD.

1. Read the complete trusted user policy and optional hostile project layer.
2. Strictly decode, canonicalize, attenuate the project layer, and calculate the
   new policy identity without mutating current state.
3. Reject malformed or unsupported input and keep the current generation.
4. Atomically publish one immutable config generation for requests arriving
   after the swap.
5. Append retained config-reload success/failure evidence before exposing a
   successful generation.

Requests already retained or awaiting an operator keep their original request,
tier, and decision history; an expanded auto rule cannot silently upgrade them
to auto-approved. At application time every approval is revalidated against the
current authoritative policy and deny set, so a newly narrowed policy can still
refuse an old pending request. New requests use the new config generation.

Changing policy data never changes a live box. If enforcement must change, the
companion box policy reload runs separately.

## Binary reload: graceful handoff protocol

### FD inventory

The versioned manifest identifies each FD by role and retained evidence, never
by an ambient integer alone:

- the bound request **listening socket**;
- accepted request connections that have a complete or partial frame;
- one seccomp notification listener per observed box;
- the corresponding denial log FD;
- the guardian/writer-fence channel;
- optional pidfds for the active box and gate generations where supported.

For every accepted request connection the manifest includes correlation state
and any bytes already removed from the stream. A complete pending request is
retained before its connection can transfer. A partial frame transfers both its
FD and bounded parser buffer. This preserves the one-request-per-connection
protocol without replaying or dropping bytes.

For every seccomp listener the manifest binds box PID, launch ID, compiled
policy hash, denial-rule digest, log identity, and outstanding notification
ledger. The successor reconstructs classifier data from the retained launch
policy and must reproduce the denial-rule digest before receiving work.

### Transaction

1. **Prepare successor.** Generation N+1 starts with no authority to accept,
   append, resolve, or launch. It validates binary compatibility, state,
   checkpoint schema, policy identities, projections, and boundary paths.
2. **Quiesce intake.** Generation N stops `accept()` and seccomp `NOTIF_RECV`
   calls. Kernel queues remain attached to the retained FDs. It finishes any
   mutation currently inside the serialized gate critical section.
3. **Normalize in-flight work.** Partial request frames remain bounded and are
   recorded for transfer. Already-received seccomp notifications are either
   answered by N or entered in the transfer ledger; they are never abandoned.
4. **Freeze checkpoint.** N appends and fsyncs a reload-prepare entry, then
   snapshots the event offset/digest and all projections. N remains the sole
   writer.
5. **Pass capability bundle.** The guardian/old generation sends FDs with
   `SCM_RIGHTS` plus the strict manifest over a private one-shot Unix channel.
   The successor process adapter exposes only those validated descriptors
   through a typed socket-activation input; it never reopens a listener by
   pathname. N+1 verifies every FD role, peer credentials, checkpoint digest,
   session, filter/rule identity, and state boundary.
6. **Prove readiness.** N+1 validates outstanding seccomp IDs with
   `SECCOMP_IOCTL_NOTIF_ID_VALID`, proves it can poll each listener, and reports
   `READY(checkpointDigest, fdManifestDigest)`. It still cannot mutate.
7. **Commit writer fence.** N appends and fsyncs the reload-handoff entry. The
   guardian atomically advances its active generation token to N+1. Only then
   may N+1 append or resolve.
8. **Activate successor.** N+1 resumes pending request connections, services
   transferred seccomp IDs, starts listener polling/accept, and appends
   reload-active evidence. N closes its copies only after this acknowledgement.
9. **Retire old generation.** N exits. The stable guardian remains, so the box
   liveness identity and box PIDs do not change.

At no phase may N and N+1 both hold the writer token. A timeout or mismatch
before step 7 returns intake to N. A failure after step 7 is fail-stop for gate
service; the guardian retains the boxes and FDs for operator recovery but cannot
adjudicate or widen.

## Seccomp user-notification handoff finding

The Linux kernel documentation explicitly says the listener FD returned by
`SECCOMP_FILTER_FLAG_NEW_LISTENER` can be passed via `SCM_RIGHTS`, belongs to a
filter rather than one task, and has synchronized reads/writes safe for multiple
readers. This verifies that a successor can hold the same live listener without
reinstalling the filter or restarting the box.

It does **not** supply a transactional supervisor handoff. `NOTIF_RECV` changes
a notification from INIT to SENT; another reader will not receive that SENT
item. The response is keyed by the unique-per-filter ID, and `NOTIF_ID_VALID`/
`NOTIF_SEND` operate through the listener. Therefore:

- queued INIT notifications can be received by N+1 after FD transfer;
- a SENT notification can be completed by N+1 only if N also transfers its ID
  and the user-space classification/response ledger;
- N+1 must revalidate the ID immediately before effects and response;
- closing the final listener reference detaches the notifier and the kernel
  completes unreplied notifications with `-ENOSYS`, so the guardian must retain
  a duplicate until activation completes;
- there is no kernel promise that makes an old userspace classifier's partial
  work recoverable. The protocol must drain or explicitly transfer it.

Primary sources, verified 2026-07-23:

- Linux kernel userspace seccomp documentation, pinned at commit
  [`4539944e`](https://github.com/torvalds/linux/blob/4539944e515183668109bdf4d0c3d7d228383d88/Documentation/userspace-api/seccomp_filter.rst#L191-L282),
  especially lines 206–211 (SCM_RIGHTS, filter identity, synchronized readers)
  and 249–260 (receive and ID-keyed response).
- Linux kernel implementation at the same commit:
  [`seccomp_notify_recv`](https://github.com/torvalds/linux/blob/4539944e515183668109bdf4d0c3d7d228383d88/kernel/seccomp.c#L1552-L1623)
  marks INIT as SENT;
  [`seccomp_notify_send` and ID validation](https://github.com/torvalds/linux/blob/4539944e515183668109bdf4d0c3d7d228383d88/kernel/seccomp.c#L1625-L1694)
  find the notification by filter-scoped ID; and
  [`seccomp_notify_detach`](https://github.com/torvalds/linux/blob/4539944e515183668109bdf4d0c3d7d228383d88/kernel/seccomp.c#L1457-L1496)
  resolves unreplied notifications with `-ENOSYS` when the listener file is
  finally released.

## Companion: box policy-source reload

A gate-owned watcher treats filesystem notifications only as dirty hints. It
never compiles bytes supplied by a watcher event and never reacts to each edit
individually.

1. Mark the source dirty and debounce a bounded burst.
2. Read the latest complete source, strict-decode it, fold the project layer
   narrow-only, canonicalize it, compile it, and re-run operator-boundary
   checks.
3. If more edits arrive during validation, discard the candidate and restart
   from the latest bytes. Equivalent policy identities are a no-op.
4. Queue one replacement for the latest valid identity.
5. Wait for a verified `SafePointPort` result for the bound Codex/Claude
   session: no gate mutation or prepared launch transaction, no unresolved
   seccomp notification, and a harness-specific turn/checkpoint boundary.
6. Immediately revalidate source identity, canonical paths, session binding, and
   the safe-point token. If any changed, return to step 1.
7. Use the existing stop → complete-policy launch → exact UUID resume
   transaction and commit launch evidence before accepting the child.

`SafePointPort` is a fail-loud prerequisite, not a sleep or an "idle-looking"
heuristic. A process blocked in or executing a syscall is not a safe point. If a
verified adapter cannot establish a userspace boundary, the old box continues
and the reload remains pending. Implementation must first prove a Codex/Claude
safe-point signal; this design does not generalize it to arbitrary harnesses.

A safe-point timeout, malformed policy, unsupported platform, changed canonical
path, or failed compile leaves the current box running. Multiple valid edits
coalesce to the latest identity. Once the old box stops, any failure is the
existing fail-stop behavior; no weaker fallback launches.

A trusted user-policy edit may intentionally authorize more, but reload itself
creates no authority: the launched policy must be exactly the freshly validated
trusted source plus narrow project layer and already-bound grants. Project data,
watch events, filenames, and request prose remain non-authoritative.

## Invariants

### No authority widening by reload

- Gate binary handoff carries the same authoritative/effective policy hashes and
  grant set; it cannot add a grant or change a decision tier.
- Data reload changes authority only through the existing trusted policy and
  narrow-only project fold.
- Box reload launches exactly one complete compiled policy through the existing
  evidence path.

### No dropped pending escalation

- Retained request/decision events remain source of truth.
- Listener, accepted connection, partial bytes, and request correlation transfer
  together.
- A pending request gets one tied decision or an explicit retained failure,
  never EOF caused merely by graceful reload.

### No lost denial observation

- Listener, compiled-rule digest, log FD, and outstanding ID ledger transfer as
  one capability bundle.
- Intake quiesces before checkpoint; every received ID is drained or
  transferred.
- The last listener reference is never closed before successor activation.

### Core pagu rules remain binding

Deny wins; reads are untrusted; evidence derives from material used for launch;
gate administration stays outside the box; enforcement remains in the box; and
unsupported handoff/safe-point behavior fails loud rather than weakening.

## Capability falsifiers

| Capability                 | Falsifier that must fail before implementation and pass before shipment                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| config/tier reload         | A malformed or project-widening edit changes effective authority, or an already-pending request is silently upgraded to auto-approved.                                        |
| durable state adoption     | N+1 accepts a mismatched event digest/session/policy hash, trusts stale JSON over the log, reuses an ID, or loses a spent-once marker.                                        |
| single writer              | N and N+1 can both append or resolve after the writer-fence commit.                                                                                                           |
| request listener handoff   | A request connected before/during/after swap gets EOF, duplicates its event, or receives another request's decision. Include a partial frame and a pending operator decision. |
| mounted socket continuity  | A real pre-existing box cannot file a request after reload without being relaunched. Assert the box PID and socket inode remain unchanged.                                    |
| seccomp listener handoff   | Denied `openat` calls immediately before/during/after swap do not each produce exactly one record, or an allowed call produces one.                                           |
| seccomp in-flight transfer | Hold a notification after `NOTIF_RECV`, swap generations, and show the successor answers that exact ID without `ENOSYS`, duplicate response, or indefinite block.             |
| denial-rule identity       | The successor accepts a listener when reconstructed compiled `fs.deny`/rule digest differs from retained launch evidence.                                                     |
| guardian liveness          | Retiring N terminates or changes the PID/mount namespace of any existing box.                                                                                                 |
| box edit coalescing        | A burst of policy writes launches an intermediate identity or more than one replacement instead of the latest valid policy.                                                   |
| safe point                 | A held syscall, outstanding seccomp ID, active grant transaction, or absent harness checkpoint still allows stop/relaunch.                                                    |
| box fail-secure reload     | Invalid/unsupported policy stops the current box or launches a weaker fallback.                                                                                               |
| exact resume               | Policy reload resumes a different UUID or the resumed model cannot recall pre-reload context.                                                                                 |
| evidence continuity        | A handoff or box replacement becomes active without retained prepare/commit/active or launch evidence bound to exact hashes and FDs.                                          |

## Required real journey

Shipment requires a packaged, non-nested run:

1. Start a guardian-owned fresh gate and retain box PID, mount namespace, socket
   inode, session UUID, event offset, and compiled deny digest.
2. File one complete request, one partial request frame, and one
   operator-pending request; hold one seccomp notification after `NOTIF_RECV`.
3. Start a successor binary and perform the FD/checkpoint handoff.
4. Prove all requests complete exactly once, the held notification is answered,
   before/during/after denials each emit once, and an allowed call emits none.
5. Prove the original box PID, namespace, and mounted socket inode did not
   change; inspect prepare/handoff/active evidence and one-writer fencing.
6. Burst-edit the trusted policy, prove coalescing, hold an unsafe point to
   delay replacement, then release it and verify one stop/relaunch/exact-UUID
   resume with context and exact compiled evidence.

## Implementation sequence after design approval

1. falsifier harness and versioned reload evidence/checkpoint schemas;
2. stable lifecycle guardian and generation writer fence;
3. request listener/accepted-connection handoff;
4. seccomp listener, log, rule digest, and in-flight ledger handoff;
5. data-only config reload;
6. verified Codex/Claude `SafePointPort`;
7. coalesced box policy-source reload;
8. packaged real journey and independent-context review.

No slice may silently weaken to pathname rebinding, process polling, lost
connections, dropped notification IDs, or an unverified idle heuristic.
