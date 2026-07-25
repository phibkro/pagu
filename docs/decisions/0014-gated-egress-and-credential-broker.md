# ADR-0014: gated egress is a composed outside plane, not a pagu subsystem

- Status: Accepted
- Date: 2026-07-25

## Context

An inhabitant inside pagu can reach the network but cannot authenticate.
Observed on 2026-07-25 in a delegated course-data-platform session: `gh`
returned "please run gh auth login" on every call, and a Cloudflare preview
deploy was abandoned because no credential existed in the scrubbed environment.
The agent did competent work and then hit a wall it had no path around.

The obvious fix is the wrong one. `env.pass` already copies named values from
the trusted launch environment into the box, so a token _can_ be supplied today
— by handing the untrusted process the credential itself. A prompt-injected
agent then exfiltrates it with one `curl`. Capability and containment are in
direct conflict as long as the box holds the secret.

Two further facts shaped this decision:

1. **Placeholders alone are obfuscation.** Substituting a dummy token that an
   outside broker swaps at the boundary only helps if the credential is also
   bound to a destination. A secret that can only ever be emitted toward
   `api.github.com` cannot be exfiltrated at all; that binding, not the
   placeholder, is the enforcement.
2. **Pagu's network axis cannot express a destination.** `policy.net` is a
   boolean (`src/policy/schema.ts:45`), and there is no egress chokepoint to
   bind against. Host-bound credentials are not implementable on the current
   axis.

[Claw Patrol](https://github.com/denoland/clawpatrol) (Deno, MIT, alpha) already
implements this plane: a gateway that terminates TLS, parses HTTP, SQL,
Kubernetes, and SSH, holds real credentials, swaps placeholders on the wire, and
evaluates HCL/CEL rules whose verdicts include blocking a request in flight
pending an LLM or human approver. Its `clawpatrol run` mode wraps a single
process in an unprivileged user namespace with a private TUN.

## Decision

1. **Pagu does not build an egress firewall.** Terminating TLS and parsing wire
   protocols is the largest trusted surface pagu could take on, and it directly
   contradicts the standing commitment to a small enforcement core. Pagu
   composes with Claw Patrol as the egress plane.
2. **The gateway is outside; the box is inside.** The only correct nesting is
   `clawpatrol run -- pagu HARNESS`. The inverse places the credential-injecting
   process inside the untrusted boundary and is prohibited. Because `compile.ts`
   emits `--unshare-all` and then `--share-net` when `policy.net` is true, a
   pagu box launched inside the gateway's namespace already inherits gated
   egress with no compiler change.
3. **Pagu contributes the guarantee the gateway cannot make: that it was not
   bypassed.** A new policy axis carries destinations and credential _names_
   only — never values, matching the existing `env.pass` discipline:

   ```jsonc
   "egress": {
     "gateway": "required",
     "allow":   ["api.github.com"],
     "secrets": ["gh"]
   }
   ```

   `gateway: "required"` fails the launch when no gateway is present. Without
   it, forgetting `clawpatrol run` silently yields the open internet — a weaker
   mode reached by omission, which the fail-loud invariant forbids.
4. **One adjudicator, one evidence log.** Claw Patrol's approver chain and
   pagu's Approver port, `queue.json`, and `pagu resolve` are the same
   construct. Operators must not acquire a second approval inbox. Egress
   approvals route into the existing gate queue and append to the existing event
   log.
5. **Egress widening does not stop the box.** An `fs.ro` grant must stop,
   recompile, and resume because its enforcement point is the mount namespace,
   inside. An egress or credential grant changes only outside state, so the
   request blocks on the wire, the host approves, and the call completes. The
   harness session is never interrupted.
6. **`--explain` gains an egress section:** gateway identity, allowed
   destinations, and credential names. Never values.

## Consequences

The generalizable result is a rule for the whole product: **restart-free
widening is available exactly when the enforcement point is outside the box.**
This is the first capability to get seamless approval, and it does so by being
architecturally easier than filesystem widening, not harder. It also narrows
what [ADR-0007](0007-runtime-reload.md) must eventually solve — runtime reload
is not required for the egress axis.

In-place `fs.ro` widening remains unsolved but is not out of reach: the phase-A
child broker (`scripts/child-broker-tracer.ts`) already proves a trusted outside
adapter can `nsenter` into a live box's user, mount, and PID namespaces. Doing
that plus a re-compile and post-hoc mount-table verification is a separate
decision, not this one.

Accepted costs, stated plainly:

- TLS interception requires a gateway CA trusted inside the box, and the gateway
  observes all plaintext. It is trusted, but it is substantial new trusted code
  in a different language and supply chain from pagu's Deno core.
- The credential store concentrates every token in one place. This is better
  than tokens inside an agent's environment, but it is a new single target.
- Claw Patrol is alpha software. Depending on it for credential custody is a
  deliberate risk taken on a fast-moving MIT project by the Deno team, with whom
  pagu already shares a runtime.
- Long-lived tokens behind a proxy are not the best available answer.
  Short-lived scoped credentials — GitHub App installation tokens, Cloudflare
  scoped tokens, STS — bound the blast radius far better and compose with this
  design: the gateway should inject a freshly minted token wherever the provider
  supports one. That work is per-provider and deferred, not dismissed.
- `ssh` remains denied by the schema's built-in floor. Un-denying it in favour
  of gateway-mediated SSH is a separate decision.

This decision adds no policy authority to a project layer, moves no adjudication
inside the box, and does not alter the existing request lifecycle.
