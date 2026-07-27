# ADR-0011: attest child hosts and preserve literal namespace nesting

- Status: Accepted
- Date: 2026-07-24

## Context

ADR-0010 proves that nested bubblewrap keeps the narrowest ancestor final, but
does not give an outside lifecycle owner a trustworthy way to launch or
attribute that nested child. Letting the inhabitant write launch evidence makes
lineage narration. Launching the child as a host-side sibling makes evidence
easy to own but removes the ancestor kernel namespace that supplies transitive
confinement.

A mounted launch socket is not sufficiently scoped by its pathname. A parent
inhabitant can pass that socket into a narrower child. It can also connect first
and pass the connected descriptor: Linux `SO_PEERCRED` is fixed at
connect/listen/socketpair time, so it would continue to report the parent. If
the broker trusts that connection credential, a caller-supplied parent ID, or an
opaque token, the child can ask under its parent's authority. The broker must
bind each individual message to the sending process and the kernel namespace it
actually occupies. Linux
[`unix(7)`](https://man7.org/linux/man-pages/man7/unix.7.html) distinguishes
connection-time `SO_PEERCRED` from per-message `SO_PASSCRED` /
`SCM_CREDENTIALS`.

The Linux feasibility probe on 2026-07-24 established that the trusted host can
enter a running pagu box's user, mount, network, IPC, UTS, and PID namespaces
using preserved credentials. A host-owned launcher can therefore retain process
ownership while starting `pagu-box` literally inside the parent boundary.

## Decision

1. The outside gate owns a child broker. Its public protocol is narrow:
   `launch-child` accepts a complete proposed policy, host actor metadata, and
   command argv. It has no resolution, policy-edit, arbitrary state, signal, or
   general process-control operation.
2. A trusted Linux front end receives one bounded `SOCK_SEQPACKET` message with
   `recvmsg`. `SO_PASSCRED` must supply `SCM_CREDENTIALS` for that message, and
   `SO_PASSPIDFD` must supply the matching sender `SCM_PIDFD`; missing,
   truncated, unsupported, or inconsistent ancillary data fails loud. The
   frontend captures namespace handles from that kernel-bound sender and gives
   the Deno broker one sender observation. The broker selects the parent by all
   six exact current namespace identities, never by a parent identifier in the
   frame. Actor names remain untrusted metadata.
3. Reusing a parent socket from a descendant does not reuse parent authority.
   Credentials and PID identity accompany each sent frame, so descriptor
   inheritance or transfer still attributes the descendant sender. The broker
   resolves its descendant lineage node and derives from that narrower effective
   policy. An unknown, changed, exited, or stale namespace fails closed.
4. The broker applies `deriveChildPolicy` before effects. It mints the child box
   ID and lineage node itself. Invalid policy, unknown frame fields, namespace
   mismatch, canonicalization failure, or launch-evidence mismatch rejects the
   complete operation.
5. The packaged policy compiler and evidence supervisor stays wholly in the host
   namespaces. It invokes an enforcement child that enters the exact parent
   namespaces before bubblewrap narrows them; it does not launch a
   policy-intersected sibling. This keeps the evidence emitter out of the
   hostile parent's PID namespace and `/proc` view. Policy material crosses the
   host boundary through immutable launch material, not an inhabitant-writable
   policy file.
6. The trusted launcher pins the selected parent namespace handles before
   effects and its enforcement child enters those exact handles. After launch it
   uses namespace handles/ioctls where the kernel exposes hierarchy and verifies
   the distinct mount namespace from controlled host-supervisor → setns-parent →
   packaged-bwrap construction. Network must equal the parent when shared and
   differ when isolated. Evidence/state commit precedes success and
   active-lineage registration. Any failure stops the provisional child; a
   failed stop remains tracked for shutdown retry.
7. Retained child-launch evidence binds child and parent IDs, claimed host
   actor, parent and child policy identities, request-route identity, exact
   compiled argv/environment names/command/cwd, PID, and observed namespace
   identities. The trusted event store remains outside every governed box.
8. A separate request-only route remains the help path. It may use the same
   per-message sender/namespace attribution substrate, but it does not gain
   launch or resolution authority. Child replacement after an approved request
   remains outside the live namespace and must retain request → decision →
   child-policy → replacement evidence.
9. Delivery remains tracer-first:
   - phase A ships the strict broker frame, namespace-aware pure core, retained
     launch-evidence shape, and a controlled host-owned namespace-entry tracer
     whose numeric parent process target remains live for the journey; it does
     not claim PID-reuse-safe selection or expose an inhabitant launch surface;
   - phase B connects the per-message credential/PIDFD front end and agent
     adapter, pins the attributed namespace handles, and launches through those
     exact handles;
   - phase C connects child request adjudication and replacement. No phase
     claims the later journey before its own falsifier and retained evidence
     pass.

## Consequences

Literal nesting and trusted process ownership can coexist. Linux needs a small
native message-credential/PIDFD/namespace adapter because stable Deno Unix
connections do not expose the required ancillary-message facts; Deno remains the
policy, protocol, state, and lifecycle runtime. Native code is restricted to
kernel facts and process placement and cannot adjudicate policy. A kernel
without the required per-message PIDFD facility is unsupported for this frontend
and must fail loud rather than fall back to `SO_PEERCRED` or a PID lookup
vulnerable to reuse.

The same public host socket, or even a connected descriptor, may be visible at
multiple depths without becoming ambient parent authority: the sender attached
to each message, not socket possession or connection creator, selects the
ceiling. This also permits recursive child hosting without minting bearer tokens
that an ancestor can accidentally leak.

The initial launch protocol deliberately omits stop and replace. Those are
trusted lifecycle effects triggered by gate decisions, not inhabitant commands.
An inhabitant may terminate its own descendants through ordinary process
semantics; that affects availability, not authority.

Linux is the only schema-policy enforcement target today. Other platforms must
fail loud until they provide an equivalent trusted caller/containment
attestation; they must not fall back to caller-declared lineage.

## Rejected alternatives

- **Host-launched sibling with intersected policy** — easier evidence, but one
  compiler error could escape the ancestor's kernel-enforced ceiling.
- **Connection-time `SO_PEERCRED`** — a parent can pass a connected descriptor;
  later child frames retain the parent's connection credential.
- **Caller-supplied lineage ID or token** — transferable to a narrower child and
  therefore usable to recover parent launch authority.
- **One unique pathname per child without sender credentials** — a parent can
  bind its own pathname into a child; path possession does not prove depth.
- **Inhabitant-launched child plus self-authored evidence** — transitive
  confinement holds, but lifecycle and lineage claims remain untrusted.
- **General gate socket inside the box** — combines launch/request capability
  with operator resolution and state authority.
