# ADR-0009: expose one request-only MCP tool to inhabitants

- Status: Accepted
- Date: 2026-07-24

## Context

ADR-0005 makes the typed SDK primary for programmatic consumers, but asking an
interactive coding agent to author a script or receive special prompt injection
for every denied read is poor product ergonomics. Codex and Claude both support
session-local stdio MCP configuration. MCP gives the harness a discoverable
typed tool without mounting a general control service or modifying persistent
harness configuration.

The difficult boundary is capability placement, not transport. An inhabitant may
describe one denied read and await its decision. It must not acquire operator
resolution, persistence, grant administration, gate state, or a general socket.
Approval also replaces the current box, so the request call can be interrupted
before it receives its response.

## Decision

1. Pagu ships a dependency-free Deno stdio MCP server with exactly one tool:
   `request_read_access`. Its strict arguments are one exact `path`, `need`, and
   `justification`; the adapter lowers them to the existing `fileRequest`
   request core.
2. The MCP process receives only the existing `PAGU_REQUEST_SOCKET` capability.
   It has no resolver, state path, policy writer, child launcher, or grant
   administration method. `pagu mcp` is the programmatic entrypoint.
3. Gate-owned Codex launches receive session-local dotted configuration
   overrides. Gate-owned Claude launches receive one inline `--mcp-config`. Both
   initial and resumed commands carry the same server. Pagu does not edit global
   or project harness configuration.
4. The packaged launcher supplies an exact immutable `pagu-mcp` store path and
   routes public `pagu mcp` directly to that narrow Deno wrapper. The outer box
   remains the network/filesystem enforcement boundary.
5. The in-repository pagu skill teaches the request semantics and the
   replacement lifecycle. If approval disconnects the tool call, the resumed
   inhabitant retries the original read and treats enforced access—not prose—as
   evidence.
6. This slice does not invent a status projection. A future status tool must
   derive from one canonical retained/runtime value and earn a concrete user
   journey. Host resolution remains the existing TTY and `pagu resolve` adapter.

## Consequences

Agents discover the programmatic interface through their normal tool mechanism;
humans retain the host-oriented CLI. The MCP server is not another
adjudicator—it is a typed adapter over the append-and-await request channel.
Session-local injection avoids stale user configuration and ensures a resumed
session receives the same interface.

Claude does not use `--strict-mcp-config`: inhabitants retain their ordinary
user/project MCP tools inside the outer box. A colliding or administratively
blocked server can affect discovery or narration, but cannot create a mount or
operator decision. The agent must verify an approval by retrying the denied
operation. If stronger tool-name integrity becomes necessary, it must be
designed without silently removing the inhabitant's other tools.

The server implements the bounded stdio JSON-RPC lifecycle directly. There is no
Effect or web-server dependency because the tracer has one connection-local
state machine and one existing asynchronous request effect. The implementation
can adopt a library later if protocol breadth makes that simpler.

The call-disconnect behavior is intentional. The old sandbox and its MCP child
must stop before a wider replacement becomes current, so an approval cannot
promise an ordinary in-process return.

While an operator request is pending, the stdio adapter continues to service
independent MCP messages such as ping. A client cancellation suppresses its
stale tool response but cannot retract the already-retained gate request:
inhabitant cancellation is not operator authority.

## Rejected alternatives

- **Prompt-only instructions** — undiscoverable and harness-specific; they make
  correct invocation depend on prose injection.
- **A general gate MCP server inside the box** — would collapse request and
  operator authority into one protocol surface.
- **Persistent harness configuration edits** — create global state, collide with
  user configuration, and can outlive the pagu journey that owns the request
  capability.
- **An HTTP server or framework** — adds a network-facing lifecycle without a
  user journey requiring one; stdio is already supported by both harnesses.
- **Effect by default** — the current resource and failure topology is small
  enough to remain clearer as plain Deno. Effect remains available when typed
  context, interruption, or concurrent resource ownership becomes materially
  complex.
