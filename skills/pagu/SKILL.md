---
name: pagu
description: Use when an agent needs to start or operate work through pagu, choose a profile or harness, inspect a compiled box, request a denied read from inside pagu, resolve a pending request as a trusted host, or reason about nested pagu boundaries.
---

# Use pagu

Pagu runs Codex, Claude, or Pi inside a policy-defined box. The ordinary
`pagu` command owns the box, the outside gate, and the harness session.

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

Use `pagu`, not `pagu-box`, for new workflows. `pagu-box` is a compatibility
executable.

## Start a normal journey

From the repository to work in, run:

```sh
pagu
```

This starts a fresh Codex session with the `worker` profile. Override only what
the task needs:

```sh
pagu --profile proof
pagu -- claude
pagu -- pi
pagu --harness claude -- /opt/company/agent-wrapper
```

Pagu infers Codex, Claude, or Pi from one recognized wrapped executable.
Opaque wrappers require `--harness`. Harness adapters own their fresh and
resume arguments, so do not append arbitrary child arguments.

Choose a category by the journey:

| Profile | Use |
| --- | --- |
| `advisor` | Read-oriented review |
| `worker` | Normal repository changes |
| `proof` | Repository changes without direct network access |
| `web` | Web-oriented work without Nix-daemon access |
| `infra` | Host administration with host-home access |
| `orchestrator` | Delegating through the installed agent dispatcher |

Use the narrowest category that can complete the task. Do not switch profiles
to work around a denied read; use the request journey below.

Persistent defaults live at `$XDG_CONFIG_HOME/pagu/launch.json`, falling back
to `~/.config/pagu/launch.json`:

```json
{
  "version": 0,
  "defaults": {
    "harness": "codex",
    "profile": "worker"
  }
}
```

Command-line choices override these trusted user defaults. Project files
cannot choose a broader category.

## Use a direct box only for static work

Use `pagu box` when a host needs one launch under a complete, fixed policy:

```sh
pagu box --profile worker -- deno task test
pagu box --policy ./policy.json --explain
pagu box --policy ./policy.json -- COMMAND
```

`--explain` shows the compiled launch without starting the command. A direct
box has no outside gate, request tool, replacement, or harness resume
lifecycle. Use bare `pagu` for interactive agent work that may need requests.

## Request one denied read as an inhabitant

Continue ordinary work inside the box. Only after an actual read is denied,
call the available `request_read_access` tool with:

- `path`: the one exact path that must become readable
- `need`: the concrete information or artifact required
- `justification`: why this task requires that path

The path must be one exact absolute, `$PWD`, `$HOME`, or `~` path. Do not use
wildcards, traversal, quotes, or control characters. Do not request write
access, a broad parent merely for convenience, or a change to harness
configuration.

Approval replaces the current box and resumes the same harness session. The
tool call may disconnect when the old box stops. After resume, retry the
original read. Treat successful access—not narration—as the result. If denied,
continue within the existing boundary.

If `request_read_access` is absent, report that the pagu integration is
unavailable. Do not ask the user to inject a prompt or modify persistent MCP
configuration. A programmatic inhabitant may use the public `fileRequest()`
SDK as a compatibility fallback.

## Resolve as a trusted host

Prefer the gate's own terminal prompt for a human-operated journey. For an
agent host or a separate operator terminal, launch with a known outside state
directory:

```sh
PAGU_STATE="${XDG_RUNTIME_DIR:?}/pagu/my-journey"
pagu --state-dir "$PAGU_STATE"
```

Inspect `$PAGU_STATE/queue.json`, select the exact pending request ID, then
resolve only that request:

```sh
pagu resolve \
  --state-dir "$PAGU_STATE" \
  --request r1 \
  --scope session
```

Use `--deny` to refuse, or choose `--scope once|session|persist` deliberately:

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
summary of retained request and decision evidence. Bare `pagu` remains the
default new-session journey.

## Handle nested pagu conservatively

Every child must stay within every ancestor's narrowest boundary. A child
proposal may reduce filesystem paths, network, environment names, home
visibility, and automatic read scopes; it must never regain something an
ancestor removed. Ancestor denies and refusals remain in force.

The public SDK can derive and validate a narrower child policy, but the current
product does not yet expose a general inhabitant-accessible child lifecycle.
Do not improvise one by mounting an outer state directory or operator surface
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
