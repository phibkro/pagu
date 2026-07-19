# pagu-box

A cross-platform command prefix that runs **any process** inside a hardened
sandbox. The original use case is coding agents (Claude Code, opencode,
aider, codex CLI, …) but pagu-box is process-agnostic — anything you can
launch from a shell can be wrapped:

```sh
pagu-box claude --dangerously-skip-permissions
pagu-box --profile=strict aider
pagu-box --profile=paranoid -- ./some-random-binary
pagu-box --no-net pytest                  # offline test run
pagu-box git status                       # yes, this also works
```

Sibling of [pagu] — the hermit-crab agent that the model cannot exec from.
pagu-box is **the shell without the crab**: bring your own process.

| | pagu | pagu-box |
|-|------|----------|
| Trust model | Model can't exec — capability ladder + human gate | Process boundary — sandbox + secret hiding |
| Default policy | Deny | Allow (minus a secret deny-list) |
| Agent | Custom Deno runtime | Any third-party CLI agent |
| Use when | High-trust commands, irreversible actions | Day-to-day coding with an existing agent |

## Threat model

**Defends against:** a prompt-injected or compromised agent that tries to read
your SSH keys, GPG keys, browser cookies, password store, shell history, or
cloud credentials and exfiltrate them via API calls. The agent finds an empty
directory or `/dev/null` where the secret should be.

**Does NOT defend against:**

- Side-channels (network traffic analysis, timing).
- User-confirmed destructive actions — if you approve `rm -rf ~/project`, that's
  on you. pagu-box constrains what the agent can _reach_, not what you let it
  _do_ inside that reach.
- Kernel exploits in the sandbox primitives themselves (bwrap, sandbox-exec).

## Profiles

`--profile=NAME` selects a named policy preset. CLI flags layer on top.

| Profile | $HOME policy | Default deny-list | Network | Use case |
|---|---|---|---|---|
| `default` | bound RW | full secret deny-list (below) | allowed | day-to-day coding agent |
| `strict` | tmpfs; only `$PWD` + `~/.claude` RW | implicit (nothing else reachable) | allowed | untrusted agent or experimental tool |
| `paranoid` | tmpfs; only `$PWD` RW | implicit | denied | running unknown CLI from a Reddit thread |
| `loose` | bound RW | `~/.ssh`, `~/.gnupg`, macOS Keychain only | allowed | trusted agent; minimal protection |

If `--profile` is omitted, `default` is used.

## What's hidden by `default` profile

| Path | Why |
|------|-----|
| `~/.ssh` | git push / server access |
| `~/.gnupg` | commit signing, file decryption |
| `~/.aws` | cloud credentials |
| `~/.azure`, `~/.config/gcloud` | cloud credentials |
| `~/.config/sops`, `~/.config/age` | secret-decryption keys |
| `~/.config/gh`, `~/.config/op` | GitHub / 1Password CLI tokens |
| `~/.password-store` | pass(1) |
| `~/.netrc` | git, curl credentials |
| `~/.bash_history`, `~/.zsh_history`, `~/.python_history` | command history |
| macOS: `~/Library/Keychains` | macOS keychain |
| macOS: `~/Library/{Cookies,Mail,Messages,Safari}` | browser / mail / messages |
| macOS: `~/Library/Application Support/{1Password,Bitwarden}` | password managers |
| Linux: `/etc/ssh`, `/etc/shadow` | host keys (sops master if reused), shadow |

What's **allowed** beyond that: full `$HOME` read/write, network, and standard
system paths. The agent can read your shell config, editor config, tool
configs — anything that isn't credential-bearing.

## Install

Flake input:

```nix
inputs.pagu-box.url = "github:phibkro/pagu-box";
```

home-manager:

```nix
imports = [ inputs.pagu-box.homeManagerModules.default ];
programs.pagu-box.enable = true;
```

The `pagu-box` binary appears on PATH; `pagu-box claude` launches Claude Code
under the sandbox.

## Use

```sh
pagu-box claude                              # default profile
pagu-box --profile=strict claude             # tighter sandbox
pagu-box --no-net pytest                     # any command, offline
pagu-box --allow /mnt/data claude            # extra RW bind (linux only in v1)
pagu-box --deny ~/.npmrc claude              # extra secret to hide
pagu-box --env FOO=bar claude                # pass an env var through the scrub
pagu-box -- --profile=strict claude          # `--` if your command also has --profile
```

The default env scrub forwards `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, plus `HOME`, `USER`, `PATH`, `TERM`, `LANG`, `SSL_CERT_FILE`.
Everything else is dropped. Pass extra env vars with `--env`.

## Mechanism

| | Linux | macOS |
|---|-------|-------|
| Sandbox primitive | `bubblewrap` (user namespaces) | `sandbox-exec` (seatbelt LSM) |
| Network drop | `--unshare-net` | `(deny network*)` |
| FS hide (dirs) | `--tmpfs` overlay | `(deny file-read* file-write* (subpath …))` |
| FS hide (files) | `--bind /dev/null` | `(deny file-read* file-write* (literal …))` |

The two mechanisms enforce the same policy; the underlying kernel layer is
different. Linux uses user-namespace isolation (no setuid, no kernel privileges
required). macOS uses Apple's seatbelt — officially "deprecated" since ~2018
but still actively used by Apple in their own browser sandboxing on macOS 15
(Sequoia) and there's no announced replacement.

## Status

v1 — minimum viable. Linux + macOS, allowlist via flags, deny-list compiled in
+ extendable. No telemetry, no audit log, no secret injection (yet).

Future surface, in roughly that order of likely arrival:

1. Configurable home-manager-module options mirroring the CLI flags.
2. Audit mode — log what files the agent _actually_ touched (eBPF / dtrace).
3. Secret injection — read secrets from sops/Bitwarden at invocation, inject
   into env, never persist on the agent's filesystem.
4. Per-project profile files (`.pagu-box.toml` in repo root → policy override).

[pagu]: https://github.com/phibkro/pagu
