---
summary: "Vocabulary and mental models for pagu policy, enforcement, escalation, and evidence."
tags: [concepts, reference]
---

# pagu — concepts

## Vocabulary

| Term               | Meaning in pagu                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------ |
| **harness**        | Any coding-agent process placed inside the box. It is not part of pagu's trusted core.     |
| **box**            | The OS sandbox around the harness; pagu's Policy Enforcement Point (PEP).                  |
| **gate**           | The outside-sandbox authority that adjudicates requests; pagu's Policy Administrator (PA). |
| **policy**         | Operator-authored standing authority, expressed as strict schema-v0 JSON.                  |
| **project policy** | Repository-authored attenuation of user policy; never an independent grant source.         |
| **grant**          | Gate-derived policy data tied to a request and decision scope.                             |
| **request**        | Exact read-only scope plus need and justification, sent out of the box.                    |
| **decision**       | Deny or approve with once/session/persist scope.                                           |
| **event**          | Append-only evidence of a request, decision, grant, launch, failure, or spend.             |
| **projection**     | Mutable gate-owned view such as the queue or session-grants JSON.                          |
| **explain**        | Redacted view of the same compiled result used to launch the box.                          |
| **attenuation**    | Producing authority less than or equal to a trusted parent.                                |
| **agent host**     | An agent choosing a child launch while still an inhabitant of its own parent box.          |
| **lineage**        | Outside-observed parent/child relation; trusted only when retained outside descendants.    |

## PEP and PA are different jobs

The box enforces but does not decide. The gate decides but does not enforce.

```mermaid
flowchart LR
    U["user policy"] --> PA["gate · PA"]
    PA --> P["complete policy/grant"]
    P --> PEP["box · PEP"]
    PEP --> H["harness"]
    H -. "request" .-> PA
    PA -->|"stop · compile · resume"| PEP
```

Why the separation is load-bearing:

- putting approval inside the box gives the requester a route to its own
  authority;
- putting policy judgment in the shell compiler duplicates the source of truth
  and makes prompt UX an enforcement concern;
- requiring the gate for every ordinary action harms availability and creates a
  centralized action path.

The standing policy handles the fast path. The gate handles misses.

## Authority is a partial order

Write `A ≤ B` when policy or grant `A` grants no more authority than `B`.
Project policy and derived grants must respect this order.

For schema v0, narrowing means:

| Field               | `A ≤ B` intuition                                                   |
| ------------------- | ------------------------------------------------------------------- |
| `fs.home`           | temporary home ≤ read-write host home                               |
| `fs.rw`             | every A path is canonically within a B read-write path              |
| `fs.ro`             | every A path is canonically within a B read-only or read-write path |
| `fs.deny`           | A may contain more denies                                           |
| `net`               | false ≤ true                                                        |
| `env.pass`          | A names are a subset of B names                                     |
| `escalation.auto`   | A rules are already authorized by B                                 |
| `escalation.refuse` | A may contain more refusals covered by deny                         |

This is not a symmetric configuration merge. The user layer is authority; the
project layer is a filter.

Filesystem mount paths are exact. A trailing `/**` is a pattern only in
auto/refuse scopes; treating it as a mount wildcard would make an absent literal
parent path authorize its real parent directory. A read-write parent home is an
implicit read-write root, so replacing it with temporary home plus selected
canonical subdirectory mounts is valid attenuation.

### Child derivation is strict attenuation

Repository attenuation and child derivation share the same partial order and
canonical path primitive, but differ at their user boundary:

| Input                  | Identity result       | Widening attempt                 |
| ---------------------- | --------------------- | -------------------------------- |
| hostile project policy | keep trusted subject  | ignore candidate, return warning |
| explicit child policy  | keep proposed subject | reject the complete derivation   |

An actor's authority is positional. A human or agent outside the governed
lineage can be an operator host. An agent inside a parent can host a child, but
is simultaneously a parent inhabitant. It may select an initial child no wider
than its effective policy; it cannot widen its own live namespace or an
already-running child.

The outer namespace supplies transitive confinement independently of the SDK.
Canonical lineage and launch-chain evidence require an outside owner; process
depth, environment markers, and descendant-writable files are narration.

## Bottom, complete policies, and fail-loud decoding

`{}` is the bottom policy: temporary home, no added filesystem access, no
network, no copied environment, and no escalation rules. Built-in secret denies
remain.

A non-empty policy must state every schema-v0 field. Unknown keys are rejected.
These rules prevent two ambiguous states:

- a misspelled authority field that silently does nothing;
- an omitted field whose default might widen after a version change.

Policy and grant are distinct artifacts. A grant must carry its `parent` and
`expires` fields even when null.

## Deny and refuse

`fs.deny` is enforcement policy. `escalation.refuse` is adjudication policy.

- A denied path is concealed by the box.
- A refused request is denied by the gate without asking the operator.
- Every refusal must be covered by a filesystem deny.
- Deny mounts are compiled after allows, so a broader allow cannot expose a
  denied child.

Refuse reduces operator noise; deny supplies the actual boundary.

## Request channel as a capability

The gate socket is not a general command channel. Its protocol has one
operation:

```text
append request -> await tied decision -> close
```

The request body is strict:

```ts
{
  need: string;
  justification: string;
  suggested_rule: { "fs.ro": string };
}
```

The prose explains intent to a human but carries no authority. Only the typed
rule participates in tier matching. The sandbox API has no queue-resolution or
policy-write function.

Mounting the socket is itself a capability. Without `--gate`, the path and
`PAGU_REQUEST_SOCKET` are absent.

## Tiered adjudication

```mermaid
flowchart TD
    R["typed request"] --> F{"covered by refuse?"}
    F -->|yes| D["deny · no prompt"]
    F -->|no| A{"lexical + canonical child of auto?"}
    A -->|yes| S["approve exact child · session"]
    A -->|no| O["GateApprover"]
    O --> D
    O --> W["approve once · session · persist"]
    D --> E["append evidence"]
    S --> E
    W --> E
```

Refuse precedes auto. Auto returns the exact child request, never the wildcard
ceiling. Canonical containment is required so an in-scope symlink cannot target
an out-of-scope path.

## Decision scopes

| Scope     | Authority lifetime                                  | Relaunch behavior                                                                                                       |
| --------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `once`    | One replacement launch.                             | Durably mark spent before spawn; exclude it from later relaunches. A crash may conservatively lose it, never replay it. |
| `session` | Same harness session and authoritative-policy hash. | Rebuild the applied grant chain on gate restart only when both bindings match.                                          |
| `persist` | Standing user policy.                               | Retain approval + grant in one append, project it, then atomically write; rebuild missing projection on restart.        |

Every approval creates a complete new launch policy. The gate re-resolves the
requested path, rejects a changed canonical target, stops its current child,
re-resolves once more, and starts a provisional box through the resume adapter.
It rechecks the complete operator boundary after the old sandbox stops and
commits that child only after durable evidence/state succeeds; otherwise the
wider child stops. There is no live mount widening.

## Event store and projections

The gate's markdown event log is retained history. Current gate event kinds:

- `gate-session` — versioned profile/subject/session identity and start time;
- `request` — identity, requested rule, need, justification;
- `request-decision` — verdict, tier, scope, rationale;
- `policy-grant` — derived grant identity, request, scope, exact rule.
- `policy-launch` — grant/session/policy linkage plus the exact spawned argv,
  environment names, resume command, and PID;
- `policy-launch-failed` — loud application or commit failure; any provisional
  wider box has been stopped;
- `policy-grant-spent` — durable once-consumption evidence.

The queue, operator resolution, and session-grants files can be replaced
atomically because they are projections. They and the launch artifacts live
outside every sandbox-visible policy root. They are useful for restart and UI,
but they do not replace the append-only evidence record.

Gate evidence written after the telemetry slice carries ISO timestamps.
`projectTelemetry` folds one or many logs into one public version-0 view;
`collectTelemetry` is only its filesystem adapter. Denial tables, approval
rates, decision-tier counts, and unlaunched old-grant candidates are queries of
that fold. They never decide or mutate policy. “Unused” currently means no
retained launch evidence, not no observed syscall—the latter requires the
deferred interception substrate.

`eventStream` gives entries stable offsets equal to their log-array index. A UI
can read backlog and then subscribe without becoming a writer.

## Explain is a projection, not a second compiler

The compiler returns:

```ts
interface CompiledPolicy {
  argv: readonly string[];
  environment: Readonly<Record<string, string>>;
}
```

The process adapter launches with that value. `explain` returns the same argv
and only the environment names. Gate-owned launches also ask the adapter to
write evidence after spawning that exact value. This prevents display, retained
evidence, and enforcement logic from becoming separate compilers.

## SDK first, adapters second

The public functions live behind `src/mod.ts`:

- decode, fold, compile, explain;
- file a request and serve the gate channel;
- expose that same request through one request-only stdio MCP tool;
- adjudicate and persist through typed ports;
- apply a bound grant through `GrantApplier` and `ResumeAdapter` ports;
- read a pending queue and submit an ID-bound operator resolution;
- read retained events;
- collect and query retained gate events through telemetry v0.

Human surfaces are thin adapters:

- `pagu-box` maps argv and host facts into the policy compiler;
- `pagu gate` owns the box and races the Approver port between its TTY and the
  host-only resolution projection;
- `pagu resolve` lets a herdr pane resolve that same port;
- `pagu telemetry` renders the read-only event projection as a table or JSON.

The agent adapter is `pagu mcp`, injected through harness-native session-local
configuration. It exposes only the typed request core.

An adapter may choose presentation. It may not duplicate policy meaning or
invent authority.

## Platform and lifecycle limits

- Schema-v0 enforcement is Linux-only today.
- macOS retains legacy profiles but has no schema-to-seatbelt lowering yet.
- Codex resume is verified against `codex-cli 0.144.4`; Claude UUID resume is
  verified against Claude Code 2.x.
- Opt-in Linux denial evidence covers compiled `fs.deny` for absolute
  `open`/`openat`; full-policy/path-race coverage remains follow-on work.
- Multi-host cryptographic discharge is outside v0.

These are explicit scope limits, not fallback permissions.
