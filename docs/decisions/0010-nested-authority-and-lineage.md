# ADR-0010: derive child authority from trusted lineage

- Status: Accepted
- Date: 2026-07-24

## Context

An agent inside pagu may itself host another agent. That makes one actor both an
inhabitant of its parent box and the host of a child box. The word “host” alone
therefore carries no authority: the same agent is still confined by every
ancestor namespace and must not widen its own box or an already-running child.

The existing user/project policy fold is close to the required algebra but has a
deliberately different contract. Repository policy is hostile advisory input, so
attempted widening is ignored with warnings and the trusted user subject is
retained. A child launch is an explicit authority derivation. It needs a new
subject, and a proposal that claims authority outside its parent must fail loud
rather than become a surprisingly different launch.

Lineage also cannot be inferred from environment variables, process depth, or a
file writable by an inhabitant. Nested user namespaces are part of the product's
defence in depth, so disabling them to make such a marker unforgeable would
destroy the very composition being proved.

## Decision

1. Box lineage is an outside-observed relation. Each node identifies the box,
   its parent, the actor hosting it, and whether that actor is outside the root
   or an inhabitant of the parent. “Human” and “agent” describe the actor;
   “host” and “inhabitant” describe its position in this lineage.
2. A child proposal is a complete schema-v0 policy. The pure child derivation
   preserves the child subject but accepts authority only when it is no greater
   than the effective parent policy:
   - `tmpfs` home cannot become host-home `rw`;
   - read-write paths remain below parent read-write paths;
   - read-only paths remain below parent read-write or read-only paths;
   - network is an AND capability and environment names are a subset;
   - automatic read scopes remain below a parent automatic read scope;
   - ancestor denies and refusals are absorbing and are inherited.
3. Nested path containment is canonical, not lexical. A widening, unresolved
   path, symlink escape, or unsupported path form rejects the entire derivation.
   It is not silently omitted as repository policy is.
4. An agent inhabitant may choose and launch an initial child policy derived
   from what it currently holds. It cannot change the live parent namespace, and
   it cannot widen an existing child. Any approved change still requires
   replacement by a trusted lifecycle owner; directly invoking another
   `pagu-box` remains bounded by the ancestor's kernel namespace.
5. Child help travels outward through a request-only endpoint. A child never
   receives resolution, persistence, gate state, launch administration, or a
   general control socket. The canonical route must terminate at a trusted
   ancestor lifecycle owner; an intermediate inhabitant may transport a request
   but cannot attest lineage or decide it.
6. Canonical lineage, gate state, operator decisions, and launch evidence live
   outside every descendant that they govern. Trusted launch evidence links the
   child node, parent node, parent policy identity, derived child policy
   identity, exact compiled material, and request-route identity. Values minted
   only inside an ancestor inhabitant are narration, not authority evidence.
7. This slice introduces the pure derivation/lineage model and proves transitive
   confinement with two real bubblewrap levels. A later slice must design the
   narrow trusted launch/request broker before claiming lineage-attributed child
   requests or host-owned child replacement. That broker must expose bounded
   operations, not a general gate control protocol.

## Consequences

A human outside the root and an agent inside a parent can both be child hosts,
but only their lineage position determines what they may delegate. Subject
metadata can change at each node without changing authority. A parent
inhabitant's direct nested launch is safe even if it bypasses the derivation
API: the outer namespace remains the final ceiling; the API adds fail-loud
product semantics and reviewable intent.

The stricter child contract is separate from repository attenuation. Both use
one canonical path-containment primitive, preventing those two policy folds from
drifting on symlinks or dot segments.

The two-level proof does not by itself make inhabitant-authored lineage
trustworthy. Until the trusted broker exists, child request attribution,
operator resolution, replacement, and retained launch-chain evidence remain
explicitly deferred. Pagu must not simulate them with an environment depth
counter, a writable lineage file, PID ancestry, or a broadly mounted socket.

No Effect dependency is introduced. The delivered core is deterministic policy
algebra, and the real proof is a bounded process adapter. Typed resource
lifetime may justify Effect later if the trusted broker owns concurrent nested
children and replacement cancellation.

## Rejected alternatives

- **Reuse project attenuation unchanged** — silently converts an invalid child
  request into a different policy and discards the child's identity.
- **Trust PID depth or an environment marker** — forgeable by inhabitants and in
  tension with nested user namespaces.
- **Let an inner gate own canonical state** — that gate is still an inhabitant
  of the parent and can rewrite any state visible to it.
- **Mount the outer gate's control surface** — combines request and operator
  authority in the descendant.
- **Live namespace widening** — violates launch-time policy and makes the
  narrowest ancestor cease to be the final boundary.
