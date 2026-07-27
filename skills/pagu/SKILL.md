---
name: pagu
description: Use when an agent needs to start or operate work through pagu, choose a profile or harness, inspect a compiled box, request a denied read from inside pagu, resolve a pending request as a trusted host, or reason about nested pagu boundaries.
---

# Use pagu

Pagu runs Codex, Claude, or Pi inside a policy-defined box. The ordinary `pagu`
command owns the box, the outside gate, and the harness session.

## Orient by position

Determine position before acting:

- A **host** outside a box may launch pagu. A trusted host that owns the
  journey's state directory may also resolve requests.
- An **inhabitant** works normally inside the box and may request one denied
  read. It cannot resolve requests or change the running box.
- An agent may host a narrower child while remaining an inhabitant of its own
  parent. Actor type does not create host authority.

`PAGU_REQUEST_SOCKET` proves that this process has the request-only inhabitant
interface. Its absence does not prove trusted-host status.

Treat the installed command as the authority for its version. Before an
unfamiliar operation, read `pagu --help` and the relevant command help, such as
`pagu box --help`. If the command or help is unavailable, report that plainly;
do not guess flags from this guide.

Use `pagu` for new workflows — either the gated harness journey (`pagu claude`)
or its box subcommand for anything else (`pagu box -- COMMAND ...`). The
separate `pagu-box` executable is compatibility-only; `pagu box` reaches the
same enforcement point through the supported entry point.

## Start a normal journey

From the repository to work in, name the harness. No `--` is needed:

```sh
pagu claude
pagu codex
pagu pi
```

That is a fresh session with the `worker` profile. Override only what the task
needs:

```sh
pagu claude --profile proof
pagu /opt/codex/bin/codex
pagu --harness claude -- /opt/company/agent-wrapper
```

Pagu infers Codex, Claude, or Pi from the executable's basename. Opaque wrappers
require `--harness`, and `--` is only needed when the executable would otherwise
parse as an option.

Bare `pagu` prints usage and exits without launching anything. State the intent;
do not expect a default harness.

## Sandbox something that is not a harness

A gated launch wraps exactly one executable and takes no trailing arguments,
because widening a policy stops and relaunches the session and the adapter must
reproduce the harness argv exactly.

Anything else — an ordinary command, or a harness run headlessly, which never
resumes — goes through the box, which does accept arbitrary arguments:

```sh
pagu box --profile worker -- rsync -a ./src ./dst
pagu box --policy ./policy.json -- claude -p "$prompt"
```

```sh
pagu box --policy ./policy.json --explain
```

`--explain` prints the compiled launch without starting the command.

A direct box has no outside gate, no request tool, no replacement, and no
harness resume lifecycle — it is one launch under one fixed policy. Use the
gated journey (`pagu claude`) for interactive agent work that may need to
request a denied read.

This is the answer whenever `pagu` reports that a gated launch wraps exactly one
executable.

Choose a category by the journey:

| Profile        | Use                                                     |
| -------------- | ------------------------------------------------------- |
| `advisor`      | Read-oriented review                                    |
| `worker`       | Normal repository changes                               |
| `proof`        | Repository changes without direct network access        |
| `web`          | Web-oriented work without Nix-daemon access             |
| `infra`        | Host administration with host-home access               |
| `orchestrator` | Leading delegated work; hosting narrower child journeys |

Use the narrowest category that can complete the task. Do not switch profiles to
work around a denied read; use the request journey below.

Persistent defaults live at `$XDG_CONFIG_HOME/pagu/launch.json`, falling back to
`~/.config/pagu/launch.json`:

```json
{
  "version": 0,
  "defaults": {
    "harness": "codex",
    "profile": "worker"
  }
}
```

Command-line choices override these trusted user defaults. Project files cannot
choose a broader category.

## Request one denied read as an inhabitant

Continue ordinary work inside the box. Only after an actual read is denied, call
the available `request_read_access` tool with:

- `path`: the one exact path that must become readable
- `need`: the concrete information or artifact required
- `justification`: why this task requires that path

The path must be one exact absolute, `$PWD`, `$HOME`, or `~` path. Do not use
wildcards, traversal, quotes, or control characters. Do not request write
access, a broad parent merely for convenience, or a change to harness
configuration.

Approval replaces the current box and resumes the same harness session. The tool
call may disconnect when the old box stops. After resume, retry the original
read. Treat successful access—not narration—as the result. If denied, continue
within the existing boundary.

If `request_read_access` is absent, report that the pagu integration is
unavailable. Do not ask the user to inject a prompt or modify persistent MCP
configuration. A programmatic inhabitant may use the public `fileRequest()` SDK
as a compatibility fallback.

## Resolve as a trusted host

Prefer the gate's own terminal prompt for a human-operated journey. For an agent
host or a separate operator terminal, launch with a known outside state
directory:

```sh
PAGU_STATE="${XDG_RUNTIME_DIR:?}/pagu/my-journey"
pagu claude --state-dir "$PAGU_STATE"
```

Inspect `$PAGU_STATE/queue.json`, select the exact pending request ID, then
resolve only that request:

```sh
pagu resolve \
  --state-dir "$PAGU_STATE" \
  --request r1 \
  --scope session
```

Use `--deny` to refuse, or choose `--scope once|session|persist` deliberately.
`--deny` wins if both are given, regardless of order — the narrower decision
cannot be lost to argument order:

- `once`: one replacement launch
- `session`: this harness session and policy identity
- `persist`: the user policy or named-profile grant overlay

Keep the state directory, operator resolution, and user policy outside every
path visible in the governed box. Never pass operator state to `pagu box` or
mount it into an inhabitant.

Programmatic trusted hosts may use `readPendingQueue()` and
`submitOperatorResolution()` from the public SDK. Keep the same role split:
inhabitants file requests; trusted hosts resolve them.

## Use advanced host surfaces sparingly

Use `pagu gate` only when resuming a known session or supplying an explicit
policy and state location. Use `pagu telemetry STATE_DIR...` for a read-only
summary of retained request and decision evidence. `pagu <harness>` remains the
default new-session journey; bare `pagu` only prints usage.

## Handle nested pagu conservatively

Every child must stay within every ancestor's narrowest boundary. A child
proposal may reduce filesystem paths, network, environment names, home
visibility, and automatic read scopes; it must never regain something an
ancestor removed. Ancestor denies and refusals remain in force.

The public SDK can derive and validate a narrower child policy, but the current
product does not yet expose a general inhabitant-accessible child lifecycle. Do
not improvise one by mounting an outer state directory or operator surface
inside. A directly nested box remains physically bounded by its outer box, but
it does not provide trusted lineage, request routing, or host-owned resume.

## Preserve these invariants

- The box enforces a complete launch-time policy; the gate decides requests
  outside it.
- A request never changes a live box. Approval stops, recompiles, and resumes.
- Project policy and request prose may narrow or ask; they do not grant.
- Unsupported behavior must fail visibly, never fall back to a looser mode.
- Verify claims with `--explain`, retained events, or the behavior of the
  resumed box.
