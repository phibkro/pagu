# pagu

pagu wraps any coding-agent harness in two security components:

- **box** — the Policy Enforcement Point (PEP): compile a policy into an OS
  sandbox and launch the harness inside it;
- **gate** — the Policy Administrator (PA): receive typed file-access requests,
  adjudicate them, and retain the decision evidence.

The hermit-crab model is literal: any harness is the crab, `pagu-box` is the
borrowed shell, and the gate controls the shell's aperture. The ordinary `pagu`
command owns both components. A grant never mutates a live sandbox: the gate
stops its owned child, recompiles the complete policy, and resumes the same
harness session in a new box.

The former integrated harness is preserved on branch `archive/harness` and at
tag `harness-final`. It is not part of the live architecture. The pivot and the
box/gate contract are recorded in
[ADR-0004](docs/decisions/0004-pivot-to-sandbox-plus-gate.md) and
[ADR-0005](docs/decisions/0005-grant-schema-and-gate-boundary.md). Curated
category profiles and their telemetry loop are specified by
[ADR-0006](docs/decisions/0006-profiles-growth-and-telemetry.md). The default
launch and request-only agent interface are specified by
[ADR-0008](docs/decisions/0008-default-launch-surface.md) and
[ADR-0009](docs/decisions/0009-request-only-agent-interface.md). Nested child
authority is specified by
[ADR-0010](docs/decisions/0010-nested-authority-and-lineage.md).

## Platform status

| Surface                              | Linux       | macOS                    |
| ------------------------------------ | ----------- | ------------------------ |
| Legacy `pagu-box --profile` launcher | bubblewrap  | `sandbox-exec`           |
| Category `pagu-box --profile` policy | implemented | typed unsupported error  |
| Schema-v0 `--policy` compiler        | implemented | typed unsupported error  |
| `pagu gate` request/operator daemon  | implemented | blocked by schema policy |

Schema-policy enforcement currently targets Linux. The macOS legacy profiles
remain available while a schema-to-seatbelt compiler is still open work.

## Install or run

Build both executables from the repository root:

```sh
nix build .#pagu-box .#pagu
```

Or run either flake package directly:

```sh
nix run . -- --help
nix run .#pagu
nix run .#pagu-box -- --help
```

The default flake package is `pagu`. `pagu-box` remains the direct-enforcement
and compatibility executable.

## Start a protected agent

The default journey is intentionally one command:

```sh
pagu
```

It starts a fresh Codex session under the `worker` category, with the gate
outside the sandbox and the harness inside it. No profile argument or config
file is required. On first launch, pagu creates private session state below
`$XDG_RUNTIME_DIR/pagu`; when that environment variable is unavailable, pass
`--state-dir` explicitly.

Select another category for one journey:

```sh
pagu --profile proof
```

Or wrap a verified harness executable. Pagu infers Codex or Claude from its
basename:

```sh
pagu -- claude
pagu -- /opt/codex/bin/codex
```

An opaque wrapper needs an explicit adapter:

```sh
pagu --harness claude -- /opt/company/agent-wrapper
```

The fresh/resume adapter owns harness arguments so the same session can be
reproduced after a grant. This first tracer therefore accepts exactly one
wrapped executable, not arbitrary trailing arguments.

Persistent user defaults live at `$XDG_CONFIG_HOME/pagu/launch.json`, or
`~/.config/pagu/launch.json` when `XDG_CONFIG_HOME` is unset:

```json
{
  "version": 0,
  "defaults": {
    "harness": "claude",
    "profile": "proof"
  }
}
```

The file is optional and strict: unknown fields, harnesses, profiles, or schema
versions fail before launch. Command-line choices override configured defaults.
This trusted launch file is separate from project policy; repository content
cannot select broader authority.

## Policy v0

A standing policy is strict, versioned JSON. Unknown keys fail before launch; an
empty object is deny-all.

```json
{
  "version": 0,
  "subject": { "agent": "codex", "label": "pagu checkout" },
  "fs": {
    "home": "tmpfs",
    "rw": ["$PWD", "$HOME/.codex"],
    "ro": [],
    "deny": ["~/.ssh", "~/.gnupg"]
  },
  "net": false,
  "env": { "pass": [] },
  "escalation": {
    "auto": [
      { "fs.ro": "/srv/share/reference/**", "scope": "session" }
    ],
    "refuse": ["~/.ssh/**"]
  }
}
```

Policy fields:

| Field               | Meaning                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `fs.home`           | Bind the host home read-write, or replace it with a temporary filesystem. |
| `fs.rw` / `fs.ro`   | Additional read-write or read-only bind mounts.                           |
| `fs.deny`           | Concealed paths; built-in SSH and GPG denies are always added.            |
| `net`               | Share or isolate the host network namespace.                              |
| `env.pass`          | Environment names copied into the scrubbed child environment.             |
| `escalation.auto`   | Read-only child scopes the gate may approve for the session.              |
| `escalation.refuse` | Denied child scopes rejected without prompting.                           |

`$PWD`, `$HOME`, and `~` are supported path roots. Denies are emitted after
allows, so deny wins in the compiled mount order.

### Published schema-v0 contracts

The box-accepted profile-grant contract is
[`schemas/profile-grant-v0.schema.json`](schemas/profile-grant-v0.schema.json).
It is the complete `PolicyV0` wire shape accepted by `pagu-box --policy`, so an
external authority such as Flow can lower exact read/write scopes, home,
network, and named environment channels without interpreting a curated profile.
`env.pass` authorizes copying a named variable already present in the trusted
launch environment; the artifact does not contain or provision its secret value.

The separate gate-derived grant contract is
[`schemas/grant-v0.schema.json`](schemas/grant-v0.schema.json). It extends the
complete policy shape with mandatory `parent` and `expires` derivation fields
and is not accepted by the box policy decoder. Grants are derived by the gate,
never handwritten.

Deno consumers can address the package exports as
`@phibkro/pagu/profile-grant-v0.schema.json` and
`@phibkro/pagu/grant-v0.schema.json`; their stable schema identifiers are
exported by the SDK as `PROFILE_GRANT_V0_SCHEMA_ID` and `GRANT_V0_SCHEMA_ID`.
Consumers should pin a pagu release or commit rather than following `main`
implicitly. The JSON Schemas publish strict wire shapes; `parsePolicy` and
`parseGrant` remain the semantic validators for built-in secret denies,
normalization, and refusal containment.

If a missing denied path sits beneath an overlapping read-only bind (for
example, advisor launched with `$PWD=$HOME`), Linux lowering fails loud: the
host could create that path after the check, while bubblewrap cannot install a
new mask mountpoint below the RO destination. Use a narrower repository root.

## Run a boxed harness

```sh
nix run .#pagu-box -- \
  --policy ./policy.json \
  -- codex
```

Without `--gate`, no request socket or request environment variable enters the
sandbox. The standing policy remains the whole authority.

Inspect the exact Linux lowering without launching anything:

```sh
nix run .#pagu-box -- --policy ./policy.json --explain
```

The explanation is derived from the same compiler result used for launch. It
contains environment names but not forwarded secret values.

Linux schema-policy launches can opt in to structured denial evidence:

```sh
LOG="$(mktemp -t pagu-denial.XXXXXX.jsonl)"
nix run .#pagu-box -- \
  --profile worker \
  --observe-denials "$LOG" \
  -- codex
```

The outside supervisor derives exact-file and directory-subtree rules from the
same compiled `fs.deny` value that emits bubblewrap masks. It appends strict
denial-evidence v1 JSONL to a path outside sandbox-writable roots. Observation
is off by default and Linux-only; it rejects noncanonical deny rules, while
relative or non-UTF-8 syscall paths and path races are not covered.

### Category profiles

Six checked-in policy-v0 files under [`profiles/`](profiles/) provide stable
role names:

| Profile        | Home    | Repository | Direct network | Extra host surface                 |
| -------------- | ------- | ---------- | -------------- | ---------------------------------- |
| `advisor`      | tmpfs   | read-only  | yes            | none                               |
| `worker`       | tmpfs   | read-write | yes            | Nix daemon                         |
| `proof`        | tmpfs   | read-write | no             | Nix daemon (daemon-mediated cache) |
| `web`          | tmpfs   | read-write | yes            | none                               |
| `infra`        | host RW | read-write | yes            | Nix daemon + systemd journal read  |
| `orchestrator` | tmpfs   | read-write | yes            | `agent-dispatch` runtime           |

Every category refuses the complete checked-in secret floor and starts with a
read-only session-auto seed for `/srv/share/projects/**`. `infra` is the only
category exposing journal inputs. The orchestrator does not pass `HERDR_*` or
mount `/run/user`/Herdr configuration; schema v0 does not claim a general
executable allowlist, so “delegate through `agent-dispatch`” remains a launcher
contract in addition to the filesystem/network boundary.

Use a name anywhere an explicit schema policy is accepted:

```sh
nix run .#pagu-box -- --profile advisor -- codex
nix run .#pagu-box -- --profile worker -- sh -lc 'touch built.txt'
```

Resolution is deliberately unambiguous: an explicit `--policy FILE` or one
checked-in category `--profile NAME` selects schema policy; supplying both is an
error. Category profiles cannot be combined with legacy mutation flags. The four
compatibility names below still select the legacy launcher.

### Legacy profiles

The imported launcher still supports its compatibility profiles and flags:

```sh
nix run .#pagu-box -- --profile=strict -- codex
nix run .#pagu-box -- --profile=paranoid --no-net -- claude
```

Run `pagu-box --help` for the complete compatibility surface. Legacy policy
flags cannot be combined with `--policy` or a category profile.

## Operate a gate-owned harness session directly

Bare `pagu` is the normal fresh-session path. The `gate` subcommand below is the
advanced surface for an explicit policy, state path, or existing session.

The relaunch lifecycle requires the gate to own the boxed child. For an existing
session UUID, the gate identifies Codex from
`~/.codex/sessions/**/rollout-*-UUID.jsonl` or Claude from
`~/.claude/projects/*/UUID.jsonl` unless `--harness` overrides inference; both
and neither fail loud. The selected harness is retained in gate-session v1
evidence. Codex resumes the exact UUID with its inner approval and sandbox
layers disabled because the outer box is the enforced boundary. Claude resumes
the exact UUID with `claude --resume UUID`.

For a new agent, supply `--harness codex|claude` and omit `--session` (or add
`--fresh`). The initial box runs the harness's fresh command with the same
authenticated state bind. For Codex, the gate adds an inert nonce marker to the
initial prompt, snapshots existing session IDs, and binds only the new rollout
whose content contains that marker. Concurrent unrelated rollouts are ignored,
and an unflushed marker keeps discovery polling. This attribution assumes
cooperative peers; hostile writers to the shared Codex session store remain
outside the current boundary. Claude receives a generated UUID through
`--session-id` and skips discovery entirely. Gate-session v2 records the
attributed or assigned UUID and fresh initial mode, and every later widen
resumes that UUID with context.

Immediately before launch, the gate composes only the selected harness's state:
Codex receives read-write `~/.codex`; Claude receives `~/.claude` and
`~/.claude.json`. This launch overlay appears in the compiled explanation and
does not alter the standing policy or its final secret denies. `persist`
decisions update only the user policy or named-profile grant overlay.

```sh
SESSION="<codex-session-uuid>"
if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  PAGU_STATE="$XDG_RUNTIME_DIR/pagu/$SESSION"
else
  PAGU_STATE="$(mktemp -d -t pagu.XXXXXX)"
fi
PAGU_POLICY="$HOME/.config/pagu/policy.json"

nix run .#pagu -- gate \
  --policy "$PAGU_POLICY" \
  --session "$SESSION" \
  --state-dir "$PAGU_STATE"
```

A fresh worker launch is:

```sh
PAGU_FRESH_STATE="${XDG_RUNTIME_DIR:?}/pagu/fresh-codex-verify"
nix run .#pagu -- gate \
  --profile worker \
  --harness codex \
  --fresh \
  --state-dir "$PAGU_FRESH_STATE"
```

Use `--profile worker` in place of `--policy "$PAGU_POLICY"` to start from a
curated category. The checked-in profile remains the shared immutable base; the
gate refreshes a private materialization of that base on every start, then
composes a separate sparse read-only grant overlay. `persist` changes only the
overlay, so new profile denies are not stranded behind an old snapshot.

Keep the user policy and gate state outside every `fs.rw`/`fs.ro` root. Startup
checks the effective mount topology and rejects a sandbox-visible state/socket
or sandbox-writable policy. The default state directory is
`$XDG_RUNTIME_DIR/pagu/SESSION`. Without a runtime directory, pass an absolute
private directory such as the `mktemp` result above. Startup rejects symlinks,
foreign ownership, broad modes, and replaceable non-sticky ancestry.

The gate starts `pagu-box` itself. On an existing session, pass
`--harness codex|claude` to skip harness inference. `HarnessInferenceError`
names both failed location checks; `ResumeAdapterNotVerifiedError` remains the
fail-loud behavior for an explicit unverified harness name.

Gate-owned Codex and Claude sessions launched by the packaged `pagu`
automatically discover one `request_read_access` MCP tool. After an actual
denied read, the inhabitant supplies the exact path, what it needs, and why. No
special prompt injection or persistent harness configuration is required. An
approval stops the current box, so the MCP call may disconnect; after pagu
resumes the same session, retry the original read.

The tool is request-only. It cannot resolve a request, choose its scope, inspect
gate state, persist a grant, or launch a child. The pagu agent guide at
[`skills/pagu/SKILL.md`](skills/pagu/SKILL.md) teaches this lifecycle.

Programmatic clients outside an MCP-capable harness can call the same core
through the SDK:

```ts
import { fileRequest } from "./src/mod.ts";

const decision = await fileRequest({
  need: "read shared API definitions",
  justification: "verify the local adapter against its upstream contract",
  suggested_rule: { "fs.ro": "/srv/share/reference/api" },
});
```

The mounted endpoint accepts one strict request per Unix-socket connection and
returns its tied decision. There is no resolution operation in the sandbox
protocol. `pagu mcp` is the newline-delimited stdio MCP entrypoint used by the
packaged harness adapters; it is not an operator interface.

Gate tiers:

1. matching `refuse` scope → deny without a prompt;
2. canonical child of an `auto` scope → session grant without a prompt;
3. otherwise → queue projection plus a prompt on the gate's own terminal.

Operator approvals may be `once`, `session`, or `persist`:

- `once` is durably marked before its one relaunch, so a crash can
  conservatively spend it but can never replay it;
- `session` survives gate restart only for the same session and authoritative
  policy identity;
- `persist` adds the canonical exact read-only rule to the user policy, never a
  project policy; the retained approval/grant rebuilds a missing projection and
  completes the edit on restart after an interrupted atomic policy write.

The gate resolves the requested path at decision, on restored-grant loading, and
again after the old sandbox stops immediately before enforcement. If its
canonical target changed, the wider launch is refused. On a successful
application a complete canonical policy is compiled, Codex resumes, durable
state/evidence commits, and only then does the gate accept the provisional child
as current.

The gate terminal accepts deny/once/session/persist. A herdr pane can render
`queue.json` and resolve the same Approver port from the trusted host:

```sh
nix run .#pagu -- resolve \
  --state-dir "$PAGU_STATE" \
  --request r1 \
  --scope session
```

Use `--deny` instead of `--scope` to refuse. `resolution.json` is atomically
published operator-side state and is never mounted into the box; the request
socket remains the only inside surface.

## Read gate telemetry

Telemetry is a read-only projection over one or more canonical `events.md` logs.
It does not require flow or a running gate:

```sh
nix run .#pagu -- telemetry "$PAGU_STATE" --older-than-days 30
nix run .#pagu -- telemetry "$PAGU_STATE" --json
```

The human and JSON views report top denied/refused paths, approval rate per
profile/subject, auto/operator/refuse decision counts, and old approved grants
with no retained launch evidence. Those last rows are conservative prune
candidates, not proof that a mounted path was never accessed: syscall-level use
evidence remains unavailable. Full-policy denial classification and automatic
requests remain deferred by ADR-0006.

## Derive a nested child

An agent inside pagu can act as a host to a narrower child while remaining an
inhabitant of its own parent. The public `deriveChildPolicy` core accepts a
complete parent policy, complete child proposal, and canonical path resolver. It
preserves the child's subject and rejects the whole proposal if any filesystem,
home, network, environment, or auto-escalation field exceeds the parent.
Ancestor denies and refusals are always inherited.

`rootLineage` and `deriveChildLineage` model whether the observed host is an
outside operator or a parent inhabitant. Those values become authority evidence
only when an outside lifecycle owner retains them; a child cannot attest its own
lineage.

The kernel composition can be exercised against the packaged launcher:

```sh
deno run --allow-run --allow-read --allow-write --allow-env --allow-net \
  scripts/nested-box-tracer.ts /absolute/path/to/pagu-box
```

The tracer launches an ordinary child and then deliberately bypasses the
derivation API. Both run under a real outer worker namespace; neither can
recover host filesystem, network, environment, gate state, or control
capabilities removed by that ancestor.

Slice 16b phase A adds the narrow trusted broker core and a second packaged
tracer:

```sh
deno run -A scripts/child-broker-tracer.ts \
  /absolute/path/to/pagu-box /absolute/path/to/nsenter
```

The broker accepts only `launch-child`, selects the parent from trusted
per-message sender/namespace facts rather than a caller-supplied lineage ID,
derives the complete child policy, and commits strict `child-launch` v0 evidence
before making the child active. The tracer keeps the packaged policy/evidence
supervisor wholly in host namespaces, then uses an explicit absolute `nsenter`
to put only its enforcement child in the live parent namespaces before
bubblewrap narrows them again. It passes immutable policy JSON to that host
supervisor, observes distinct child namespace identities, and retains
parent/child policy hashes, request-route identity, compiled argv/environment
names, PID, command, cwd, and lineage outside the parent-visible tree. The
parent actively scans `/proc` and attempts an evidence-FD forgery if that
supervisor becomes visible. Failure to verify or retain evidence stops the
provisional child.

This is not yet a `pagu child` product surface. Phase A's controlled tracer
keeps its numeric parent process target live, but does not claim PID-reuse-safe
namespace selection. The native phase-B frontend must receive per-message
`SCM_CREDENTIALS` plus `SCM_PIDFD`, pin the sender's namespace handles, and use
those exact handles for launch; connection-time `SO_PEERCRED` is explicitly
insufficient because a connected descriptor can be passed to a child. The agent
adapter is also phase B; child request adjudication and replacement are phase C.
Pagu still does not mount a general control socket or treat inhabitant-authored
lineage as trusted.

## Programmatic API

The typed front door is [`src/mod.ts`](src/mod.ts). It exports:

- strict launch-config decoding, config discovery, harness inference, and launch
  resolution;
- strict policy and grant decoding;
- trusted-user plus narrow-only project policy folding;
- strict child-policy derivation and actor/box-lineage construction;
- the strict namespace-aware child-broker core and child-launch event mapping;
- pure policy compilation and explanation;
- strict denial-evidence v1 decoding;
- the request client, session-bound gate core, and Approver port;
- the request-only MCP session, tool schema, and stdio adapter;
- Codex/Claude resume adapters and the gate-owned box lifecycle;
- queue reads and resolve-only operator submission;
- retained event-log and capability primitives.
- category-profile names and the telemetry-v0 collector/projection/formatter.

The public-export floor is checked by [`src/mod.test.ts`](src/mod.test.ts). This
package is consumed from a checkout today; publication is not claimed.

The agent-facing boundary guide ships at
[`skills/pagu/SKILL.md`](skills/pagu/SKILL.md). It teaches the request and
operator seams while treating the installed tool/SDK as signature authority.

## Security model and development

- Durable boundary and threat model: [CONTEXT.md](CONTEXT.md)
- Load-bearing invariants: [docs/INVARIANTS.md](docs/INVARIANTS.md)
- Module map: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Current plan: [ROADMAP.md](ROADMAP.md)
- Contribution workflow: [docs/WORKFLOW.md](docs/WORKFLOW.md)

```sh
deno task ci
deno task check:docs
nix build .#pagu-box .#pagu
```
