# ADR-0008: `pagu` is the default gated launch surface

- Status: Accepted
- Date: 2026-07-24

## Context

The box/gate pivot produced the right security organs but exposed the
implementation split as the primary user journey. A new session required the
operator to choose `gate`, a category profile, and a harness even though pagu
already had a verified safe fresh-launch lifecycle and a natural worker
default. The root flake also launched the `pagu-box` compatibility adapter,
keeping the historical component name in front of the product name.

Humans need one memorable host command. Programmatic consumers still need typed
launch resolution rather than shell parsing. The box/gate boundary must remain
unchanged: convenience may select an existing policy and verified harness
adapter, but it must not add authority or move adjudication into the sandbox.

## Decision

1. Bare `pagu` starts a fresh gate-owned session. It lowers into the existing
   gate lifecycle with the `worker` category and Codex adapter by default.
2. Trusted user defaults live in a strict, versioned
   `~/.config/pagu/launch.json` (or the equivalent XDG config path). Version 0
   selects only a category profile and one verified harness.
3. `pagu -- EXECUTABLE` infers Codex or Claude from a single recognized
   executable basename. `--harness` is required for an opaque wrapper and a
   conflicting explicit/inferred choice fails loud.
4. Harness adapters continue to own fresh and resume argv. This slice therefore
   accepts one executable, not arbitrary child arguments that might be
   impossible to reproduce on resume.
5. `pagu gate`, `pagu resolve`, and `pagu telemetry` remain advanced
   subcommands. `pagu-box` remains a compatibility and direct-enforcement
   package.
6. The root flake's default package is `pagu`. Launch config decoding, harness
   inference, and launch resolution ship first through `src/mod.ts`; the CLI is
   their human adapter.

## Consequences

The ordinary journey becomes `pagu`, while explicit policy/session operation
remains available. Configuration cannot invent a harness adapter or a policy
shape: it names only checked-in categories and verified Codex/Claude ports.
Absence of configuration is valid; a present malformed or unknown-field config
fails before launch.

The file is intentionally separate from the archived integrated-harness
`config.json` schema. A future configuration unification must migrate that
historical API explicitly rather than interpreting one path in two ways.

MCP, an agent skill, arbitrary harness ports, nested host/inhabitant authority,
and monotone child-box attenuation remain separate tracer slices. In
particular, this decision does not mount a control or resolution capability
inside the sandbox.
