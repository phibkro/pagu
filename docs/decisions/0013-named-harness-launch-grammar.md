# ADR-0013: a launch names its harness; bare `pagu` prints usage

- Status: Accepted
- Date: 2026-07-25
- Supersedes: [ADR-0008](0008-default-launch-surface.md) decisions 1 and 3
  (bare-`pagu` launch and the `--`-separated executable form). ADR-0008's
  remaining decisions — strict `launch.json`, harness inference, adapter-owned
  argv, the advanced subcommands, and the default Nix package — stay in force.

## Context

ADR-0008 made bare `pagu` start a fresh gate-owned session under the worker
category with the Codex adapter. That bought one memorable command, and it was
the right call for a product whose only harness was Codex.

Three things changed after it shipped:

1. **Three harnesses, not one.** Slices 8, 15, and 18 added Claude and Pi. The
   built-in default now silently picks one of three adapters, and the adapter
   determines the argv, the session-identity mechanism, and which harness state
   directory is bound read-write into the box. That is no longer a small
   convenience.
2. **The thing being guessed is which policy gets enforced.** Pagu's own
   evidence standard says authority must be stated, not inferred. A launch
   surface that starts an enforcing sandbox from an empty command line is the
   one place the product contradicts its own posture.
3. **Observed friction pointed the other way.** Field feedback recorded in the
   Slice 19 review showed operators reaching for `pagu` to sandbox ordinary
   commands and appending harness arguments to it. Both are `pagu box` work.
   Bare `pagu` gave them no signal; it just launched something.

The `--` separator was also pure ceremony for the common case. `pagu -- claude`
carries no information that `pagu claude` does not.

## Decision

1. **Bare `pagu` prints usage and exits.** It launches nothing. This applies to
   the empty command line only — it is a prompt to state intent, not a rejection
   of defaults.
2. **A harness is named as a bare positional:** `pagu claude`, `pagu codex`,
   `pagu pi`, or a path whose basename infers one. `--` remains available and is
   required only when the executable would otherwise parse as an option.
   Supplying both a bare and a post-`--` executable fails loud.
3. **Trusted `launch.json` defaults still fill in whatever the caller leaves
   unspecified.** `pagu --profile proof` remains a valid launch: the caller
   stated intent, and the configured harness completes it. Configuration is a
   standing declaration, not an inference from silence.
4. **A gated launch still wraps exactly one executable with no trailing
   arguments,** because the harness adapter must reproduce that argv on resume
   (unchanged from ADR-0008 decision 4). The failure now names `pagu box` and
   prints the caller's own argv, shell-quoted, as a runnable alternative.
5. **`@std/cli` owns argv tokenisation only.** Splitting flags, positionals, and
   the post-`--` tail is the mechanical part every CLI re-implements and gets
   subtly wrong. Every decision downstream of tokenisation stays hand-owned:
   those choices select which policy is enforced, and a schema-driven parser
   cannot express them. `--harness` is validated at both parse paths, and
   `--deny` wins over any approval scope regardless of argument order.
6. **The packaged CLI resolves dependencies from the Nix store.** Adding any
   external import to a process holding `--allow-net --allow-write --allow-run`
   would otherwise turn first launch into an unauthenticated fetch. `vendor/` is
   committed and shipped into the store, and `--cached-only` makes a missing
   module fail loudly at launch instead of reaching the network.

## Consequences

The ordinary journey costs one extra token — `pagu claude` rather than `pagu` —
and in exchange every launch states which adapter and therefore which policy it
is asking for. Operators who want zero-argument ergonomics keep them through
`launch.json` plus any explicit flag.

Decision 6 makes hermeticity structural rather than accidental. Before it, the
gate CLI happened to import nothing external, so the packaged binary was
network-free by luck; one stdlib import would have silently changed that. The
cost is 116 vendored JSR files (~556K) in the repository and a manual refresh
whenever a dependency moves. That trade is deliberate: the alternative is an
unauthenticated fetch inside the most privileged process pagu runs.

This decision does not change the box/gate boundary, add a policy field, grant
new process authority, or alter the request lifecycle. It changes only how a
human states which existing category and verified adapter to launch.
