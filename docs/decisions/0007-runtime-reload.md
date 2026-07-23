# ADR-0007: runtime reload separates gate handoff from box replacement

- Status: Accepted (manager-approved design; implementation staged)
- Date: 2026-07-23

## Context

pagu's gate is the high-iteration policy-administration surface. Today changing
its code requires terminating the gate process. Gate-owned boxes deliberately
watch that process and stop when it exits, so an ordinary restart also destroys
the running enforcement boundary and interrupts its harness session.

That coupling is correct for unexpected gate loss but too coarse for a planned
binary upgrade. A graceful reload should preserve the box, mounted request
socket, pending escalations, denial observation, session binding, and retained
state while replacing only the administration process. The analogous
nginx/HAProxy pattern is a fenced successor that inherits live listeners while
the old generation drains.

Policy-source reload is a different operation. A changed enforcement policy
cannot mutate a live mount namespace; pagu must keep its established stop →
compile → relaunch → exact-session-resume lifecycle. It should coalesce editor
writes and wait for a real safe point rather than interrupting a syscall or
launch transaction.

The complete protocol and falsifiers are frozen in
[`docs/runtime-reload-design.md`](../runtime-reload-design.md).

## Primary-source finding: seccomp listener handoff

The kernel-facing question was whether a seccomp user-notification listener can
move to a successor while notifications are in flight.

The answer is **yes for the live filter FD, but not by FD transfer alone for
user-space work already received**.

The Linux kernel documentation says a listener returned by
`SECCOMP_FILTER_FLAG_NEW_LISTENER` may be passed with `SCM_RIGHTS`, corresponds
to a filter rather than a task, and has synchronized reads/writes safe for
multiple readers. A duplicate retained by a guardian therefore keeps the same
filter listener alive across gate generations; no box or filter reinstall is
needed.

The in-flight boundary is stateful:

- `SECCOMP_IOCTL_NOTIF_RECV` selects an INIT notification and marks it SENT;
- later receive calls do not return that SENT notification again;
- `NOTIF_SEND` and `NOTIF_ID_VALID` find work by its unique filter-scoped ID;
- release of the final listener file detaches notification state and completes
  unreplied work with `-ENOSYS`.

Consequently a successor can answer an already-received notification only when
the old generation also transfers its ID and user-space classification/response
ledger. Otherwise the old generation must drain it before handoff. The kernel
does not provide a transactional supervisor swap or reconstruct partial
user-space classification.

Verified primary sources (Linux commit
[`4539944e515183668109bdf4d0c3d7d228383d88`](https://github.com/torvalds/linux/commit/4539944e515183668109bdf4d0c3d7d228383d88)):

- [userspace seccomp notification documentation, lines 191–282](https://github.com/torvalds/linux/blob/4539944e515183668109bdf4d0c3d7d228383d88/Documentation/userspace-api/seccomp_filter.rst#L191-L282):
  SCM_RIGHTS transfer, filter identity, synchronized readers, receive, response,
  and notification lifetime;
- [`seccomp_notify_recv`, lines 1552–1623](https://github.com/torvalds/linux/blob/4539944e515183668109bdf4d0c3d7d228383d88/kernel/seccomp.c#L1552-L1623):
  INIT → SENT transition;
- [`seccomp_notify_send` and ID validation, lines 1625–1694](https://github.com/torvalds/linux/blob/4539944e515183668109bdf4d0c3d7d228383d88/kernel/seccomp.c#L1625-L1694):
  filter-scoped lookup and exactly-one response;
- [`seccomp_notify_detach`, lines 1457–1496](https://github.com/torvalds/linux/blob/4539944e515183668109bdf4d0c3d7d228383d88/kernel/seccomp.c#L1457-L1496):
  final-release behavior for unreplied notifications.

### Slice-1 spike finding

Deno FD adoption is viable through a small, narrowly exported native library
loaded with path-scoped FFI. The spike received a manifest-bound seccomp
listener through `SCM_RIGHTS`, duplicated it with `F_DUPFD_CLOEXEC`, closed the
original, and completed a real notification through the duplicate. The native
surface was 65 lines of C with a 58-line typed Deno caller. Direct raw-libc FFI
also worked, but `UnsafePointer` required unrestricted `--allow-ffi`; that shape
is rejected. The narrow shim did not balloon, so this ADR's native-shim revisit
condition was not triggered.

## Decision

### 1. Gate data reload and gate binary reload are separate capabilities

Trusted policy/tier data is strict-decoded and atomically swapped within the
active gate. Existing pending requests are not silently re-tiered; application
still revalidates against current authority and deny state. Enforcement changes
wait for box policy reload.

A gate binary reload starts a fenced successor generation. It replays retained
state, verifies projections and policy/session hashes, then receives the live
request listener, accepted request connections, seccomp listeners, denial logs,
and outstanding notification ledger through a private host-only FD handoff.
Exactly one generation owns the state-writer token.

### 2. A stable lifecycle guardian anchors boxes across gate generations

The box cannot continue watching the PID of a gate generation that is expected
to exit. A narrow guardian owns the child-liveness identity and generation
fence. It retains duplicate live FDs during planned handoff but has no request,
tier, grant, policy-edit, or denial-classification authority.

The guardian and its handoff endpoint remain outside all sandbox mounts.
Unexpected loss is not reclassified as graceful reload; fail-secure crash
behavior remains.

### 3. FD handoff is manifest-bound and transactional

FD integers carry no meaning by themselves. A strict, versioned checkpoint binds
each FD to session, launch, box PID, event offset/digest, policy hash, compiled
deny-rule digest, log identity, request parser state, and outstanding seccomp
IDs.

The old generation remains active until the successor validates state and FDs.
It then fsyncs handoff evidence and transfers the single-writer fence. The
successor services transferred work and acknowledges activation before old FD
copies close. Before fence commit, failure returns service to the old
generation; after commit, failure is fail-stop and cannot widen.

### 4. Pending request and denial work are part of the transaction

Passing only listening FDs is insufficient.

- Accepted request connections transfer with correlation state and any bounded
  partial frame bytes. A retained pending request receives exactly one tied
  decision or explicit retained failure.
- Seccomp listeners transfer with the exact compiled-rule digest, log FD, and
  every already-received notification ID. Each ID is drained or validated and
  completed by the successor before retirement.

### 5. Box policy reload remains stop/relaunch/resume

A trusted policy-source watcher supplies dirty hints only. Bursts coalesce to
the latest complete, strict-decoded, canonical, boundary-checked policy
identity. Invalid candidates leave the current box running.

Replacement waits on a verified Codex/Claude safe-point port: no gate mutation,
prepared launch, outstanding seccomp notification, active syscall, or missing
harness checkpoint. No sleep, mtime, pane status, or "looks idle" heuristic can
stand in for that proof. If no verified safe point exists, reload remains
pending and the box continues.

At the safe point pagu uses its existing complete-policy replacement and exact
UUID resume transaction. A trusted edit may deliberately change authority, but
the reload mechanism itself cannot infer or add authority; project input still
only narrows.

## Invariant consequences

- **Gate never widens by itself:** binary handoff preserves exact hashes/grants;
  data and box reload use existing trusted-policy and decision paths.
- **Deny wins:** successor denial rules must reproduce the retained compiled
  digest before it can consume a seccomp listener.
- **Reads are untrusted:** watcher events, project policy, partial frames, and
  handoff prose cannot authorize changes.
- **Evidence outranks narration:** prepare, handoff, active generation, config
  reload, safe point, and replacement launch evidence bind exact state, FDs,
  hashes, and PIDs.
- **No dropped pending escalation:** accepted connections and parser/correlation
  state are transferred, not recreated from a pathname.
- **No lost denial observation:** no received notification ID is omitted and the
  final listener reference remains open through activation.

## Consequences

- Planned gate binary upgrades can preserve box PIDs, mount namespaces, request
  capability, and session context.
- The TCB gains a deliberately narrow stable guardian and a versioned FD
  handoff/checkpoint protocol.
- A seccomp handoff must transfer user-space in-flight state as well as the FD;
  this is more work than generic socket activation.
- Reloadable operation begins only after a session has launched under the
  guardian. Existing sessions need one ordinary replacement.
- Safe-point verification is a separate prerequisite. Generic arbitrary-process
  hot reload is not claimed.
- Gate availability may pause during the bounded handoff, but already-running
  boxes and kernel listener queues remain intact; no authority fallback exists.

## Rejected alternatives

- **Kill and restart the gate, then resume every box** — rejected for the
  primary operation: it defeats zero-downtime administration and interrupts
  unrelated boxes.
- **Rebind the request socket pathname** — rejected: existing bind mounts retain
  the old socket object.
- **Pass only listener FDs** — rejected: accepted request buffers and SENT
  seccomp notifications are user-space state and would be dropped or stranded.
- **Let old and new gates write concurrently** — rejected: projections and grant
  IDs would cease to be evidence-backed single-writer state.
- **Close the old seccomp listener after sendmsg without an activation fence** —
  rejected: losing the final file reference resolves outstanding work with
  `ENOSYS`.
- **Treat a watcher event as policy** — rejected: filesystem events and project
  bytes are untrusted hints, not authority.
- **Stop on a debounce timer and call it a safe point** — rejected: timers do
  not prove that a syscall, notification, gate transaction, or harness turn is
  complete.
- **Generalize reload into an arbitrary-harness gate port** — rejected for this
  decision; the existing explicit deferral remains.

## Revisit conditions

Revisit if a verified Codex/Claude safe-point signal cannot be established, if
Deno cannot participate in manifest-bound FD adoption without an unjustifiably
large native shim, if the guardian cannot retain current fail-secure crash
semantics, or if a real kernel falsifier contradicts the documented in-flight
notification behavior.
