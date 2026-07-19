# pagu

pagu wraps any coding-agent harness in two security components:

- **box** — the Policy Enforcement Point (PEP): compile a policy into an OS
  sandbox and launch the harness inside it;
- **gate** — the Policy Administrator (PA): receive typed file-access requests,
  adjudicate them, and retain the decision evidence.

The hermit-crab model is literal: any harness is the crab, `pagu-box` is the
borrowed shell, and `pagu gate` controls the shell's aperture. A grant never
mutates a live sandbox: the gate stops its owned child, recompiles the complete
policy, and resumes the same harness session in a new box.

The former integrated harness is preserved on branch `archive/harness` and at
tag `harness-final`. It is not part of the live architecture. The pivot and the
box/gate contract are recorded in
[ADR-0004](docs/decisions/0004-pivot-to-sandbox-plus-gate.md) and
[ADR-0005](docs/decisions/0005-grant-schema-and-gate-boundary.md).

## Platform status

| Surface                              | Linux       | macOS                    |
| ------------------------------------ | ----------- | ------------------------ |
| Legacy `pagu-box --profile` launcher | bubblewrap  | `sandbox-exec`           |
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
nix run .#pagu-box -- --help
nix run .#pagu -- gate --help
```

The default flake package is the `pagu-box` compatibility executable. A unified
`pagu box` subcommand is planned; it is not shipped yet.

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

### Legacy profiles

The imported launcher still supports its compatibility profiles and flags:

```sh
nix run .#pagu-box -- --profile=strict -- codex
nix run .#pagu-box -- --profile=paranoid --no-net -- claude
```

Run `pagu-box --help` for the complete compatibility surface. Legacy policy
flags cannot be combined with `--policy`.

## Run a gate-owned Codex session

The relaunch lifecycle requires the gate to own the boxed child. Supply an
existing Codex session UUID; the verified adapter runs `codex resume UUID` for
the initial box and every approved relaunch. The policy is the user policy;
`persist` decisions update this file only.

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
  --harness codex \
  --state-dir "$PAGU_STATE"
```

Keep the user policy and gate state outside every `fs.rw`/`fs.ro` root. Startup
checks the effective mount topology and rejects a sandbox-visible state/socket
or sandbox-writable policy. The default state directory is
`$XDG_RUNTIME_DIR/pagu/SESSION`. Without a runtime directory, pass an absolute
private directory such as the `mktemp` result above. Startup rejects symlinks,
foreign ownership, broad modes, and replaceable non-sticky ancestry.

The gate starts `pagu-box` itself. The Claude resume port exists but raises the
typed `ResumeAdapterNotVerifiedError`; no unverified argv fallback is used.

The in-sandbox SDK call is:

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
protocol.

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

## Programmatic API

The typed front door is [`src/mod.ts`](src/mod.ts). It exports:

- strict policy and grant decoding;
- trusted-user plus narrow-only project policy folding;
- pure policy compilation and explanation;
- the request client, session-bound gate core, and Approver port;
- Codex/Claude resume adapters and the gate-owned box lifecycle;
- queue reads and resolve-only operator submission;
- retained event-log and capability primitives.

The public-export floor is checked by [`src/mod.test.ts`](src/mod.test.ts). This
package is consumed from a checkout today; publication is not claimed.

The agent-facing boundary guide ships at
[`skills/pagu/SKILL.md`](skills/pagu/SKILL.md). It teaches the request and
operator seams while treating the installed SDK as signature authority.

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
