# ADR-0012: Pi uses an assigned session and native request-tool adapter

- Status: Accepted
- Date: 2026-07-25

## Context

Pi is a useful local-first harness for pagu because it can run Ollama models
without consuming a hosted-agent subscription. It supports exact caller-chosen
session IDs, exact session reopening, explicit session-local extensions, and
explicit skills. Unlike Codex and Claude, Pi deliberately does not implement an
MCP client.

Pagu already has one request core and one request-only stdio MCP adapter.
Implementing the Unix request protocol again inside a Pi extension would create
a second client contract. Editing Pi's persistent extension settings would also
outlive the gate-owned journey. The adapter therefore needs to be native to Pi
without becoming a new authority surface.

Pi installations may be self-contained or may use a launcher in the Nix profile
that points to a package below the user's otherwise concealed home. The session
state needs write access; installed runtime code does not.

## Decision

1. `pi` is a verified `HarnessName`. Bare launch configuration, `--harness`,
   and wrapped-executable inference may select it.
2. A fresh Pi launch receives a generated UUID through `--session-id`; resume
   reopens exactly that UUID through `--session`. Pi therefore uses assigned
   attribution like Claude and does not poll a session store.
3. Pi state inference searches
   `~/.pi/agent/sessions/**/*_SESSION_ID.jsonl`. Exactly one matching Codex,
   Claude, or Pi store is required when the operator does not select a harness.
4. The packaged launcher passes one immutable extension with `--extension` and
   the pagu skill with `--skill` on both fresh and resume commands. It does not
   edit user or project Pi configuration and does not suppress ordinary Pi
   tools or extensions.
5. The extension registers exactly one native `request_read_access` tool. It
   translates that call through the exact packaged `pagu-mcp` process, so
   request decoding, append-and-await behavior, cancellation semantics, and
   the absence of operator methods remain shared with Codex and Claude.
6. The Pi overlay mounts `~/.pi` read-write. The two common user-local package
   roots for the Earendil and upstream Pi packages are mounted read-only when
   present. Missing paths grant nothing; other installation layouts must use a
   self-contained executable until a trusted runtime-root configuration earns
   a separate design.
7. Routine lifecycle regression remains the provider-free mock journey. Changes
   to Pi's own adapter contract receive a packaged smoke with a local Ollama
   model and hosted-provider credentials removed. Remote free tiers are an
   optional fallback, not CI or release authority.

## Consequences

Pi inhabitants see the same tool name and request semantics through their native
tool mechanism. Humans continue to use the same `pagu`, `pagu gate`, and
`pagu resolve` surfaces. Approval may stop the Pi process before the tool call
returns; the exact session is reopened in the replacement box and retries the
original read.

The extension is transport glue, not a new SDK core. It cannot resolve, choose
a grant scope, mutate state, persist policy, or launch a child. Its subprocess
uses an exact argv, bounded output, and no shell.

The two read-only package roots are compatibility for common user-local npm
layouts, not general home visibility. Final policy denies still overlay them.

## Rejected alternatives

- **Pretend Pi supports MCP configuration** — Pi explicitly chooses extensions
  instead of an MCP client.
- **Implement the request socket protocol in the extension** — duplicates the
  request contract and its edge cases.
- **Prompt injection** — makes discovery narration-dependent and
  harness-specific.
- **Persistent Pi configuration edits** — outlive the owning pagu journey and
  collide with user configuration.
- **Mount all of `~/.local` or the host home** — exposes more than the selected
  runtime requires.
- **Use a hosted model for routine verification** — consumes scarce capacity
  without improving the deterministic lifecycle proof.
- **Introduce Effect or a server framework** — the adapter is one bounded
  subprocess exchange over an existing core.

## Revisit conditions

Revisit the known runtime roots when Pi has a stable self-contained package or a
portable executable-to-runtime manifest. Revisit the bridge if Pi adds a
session-local MCP client whose capability placement is equivalent. A general
trusted runtime-root configuration must be designed as launch authority, not
accepted from repository content.
