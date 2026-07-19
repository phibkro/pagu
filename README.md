# pagu

pagu wraps any coding-agent harness in two security components:

- **box** — the Policy Enforcement Point (PEP): compile a policy into an OS
  sandbox and launch the harness inside it;
- **gate** — the Policy Administrator (PA): receive typed file-access requests,
  adjudicate them, and retain the decision evidence.

The hermit-crab model is literal: any harness is the crab, `pagu-box` is the
borrowed shell, and `pagu gate` controls the shell's aperture.

> Current boundary: the gate decides and records grants. Relaunching a harness
> with an approved grant is the next slice and is not implemented yet.

The former integrated harness is preserved on branch `archive/harness` and at
tag `harness-final`. It is not part of the live architecture. The pivot and the
box/gate contract are recorded in
[ADR-0004](docs/decisions/0004-pivot-to-sandbox-plus-gate.md) and
[ADR-0005](docs/decisions/0005-grant-schema-and-gate-boundary.md).

## Platform status

| Surface                              | Linux       | macOS                   |
| ------------------------------------ | ----------- | ----------------------- |
| Legacy `pagu-box --profile` launcher | bubblewrap  | `sandbox-exec`          |
| Schema-v0 `--policy` compiler        | implemented | typed unsupported error |
| `pagu gate` Unix-socket daemon       | implemented | implemented             |

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
    "rw": ["$PWD"],
    "ro": ["/srv/share/reference"],
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

## Run the gate

Start the gate outside the sandbox. The policy passed here is the user policy;
`persist` decisions update this file only.

```sh
mkdir -p .pagu/gate

nix run .#pagu -- gate \
  --policy "$PWD/policy.json" \
  --socket "$PWD/.pagu/gate/request.sock" \
  --state-dir "$PWD/.pagu/gate"
```

Then opt a boxed launch into that channel:

```sh
nix run .#pagu-box -- \
  --policy "$PWD/policy.json" \
  --gate "$PWD/.pagu/gate/request.sock" \
  -- codex
```

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

Operator approvals may be `once`, `session`, or `persist`. Once and session
grants are stored in the gate state directory and survive a gate restart.
Persist adds the exact requested read-only rule to the user policy. Every
request, decision, and grant is appended to `events.md`.

Approving a request does not change the already-running sandbox in this release.
Stop there unless you are developing the relaunch/resume slice.

## Programmatic API

The typed front door is [`src/mod.ts`](src/mod.ts). It exports:

- strict policy and grant decoding;
- trusted-user plus narrow-only project policy folding;
- pure policy compilation and explanation;
- the request client, gate core, and Approver port;
- retained event-log and capability primitives.

The public-export floor is checked by [`src/mod.test.ts`](src/mod.test.ts). This
package is consumed from a checkout today; publication is not claimed.

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
