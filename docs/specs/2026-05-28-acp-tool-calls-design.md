# ACP tool-call surfacing — design (v1)

> Status: design, pending grill-with-docs. Roadmap: CONTEXT.md → Open → "ACP —
> remaining integration work" (surface tool calls). Authored via brainstorming.
> Grounded in the ACP spec (agentclientprotocol.com/protocol/tool-calls) + the
> SDK types (`ToolCall`/`ToolCallUpdate`).

## Goal

Surface pagu's actions in the editor as ACP **tool calls** —
`script`/`skill-invoke`/ `command-invoke` become `tool_call`s and their `result`
a `tool_call_update`, both **live** (as the agent acts) and on **replay**
(reopening a thread). Zed then shows "agent ran X" with status, not just
streamed text.

## Scope

- **Tool calls** for the action entries + their results (this slice).
- **Deferred — thinking** (`agent_thought_chunk`): no reasoning/`<think>`
  separation exists in pagu today; it needs a provider/streaming-layer change
  (parse qwen's inline `<think>` or surface a provider `reasoning_content`),
  model-specific. Its own later slice.
- **Deferred**: diff/terminal tool-call content types (we use plain text
  content); the `· read X` status markers that currently ride the token stream.

## Spec facts (researched)

ACP `tool_call` (`session/update`):
`{toolCallId, title, kind?, status?, content?,
locations?, rawInput?, rawOutput?}`
— `title` + `toolCallId` required. `tool_call_update` is keyed by `toolCallId`
with optional `status`/`content`/….
`kind ∈ read | edit |
delete | move | search | execute | think | fetch | switch_mode | other`.
`status ∈
pending | in_progress | completed | failed` (lifecycle: pending →
in_progress → completed/failed). Content: `{type:"content"|"diff"|"terminal"}`.

## The model — one stateless `entryUpdate` mapper

Generalize the replay mapper (`historyUpdates`) into a single per-entry function
used by **both** replay and live. The log already links results to actions
(`result.script === action.id`, `schema.ts:84`), so the mapping is **stateless
per entry — no pairing logic**:

```ts
// entry → the session/update that surfaces it, or null (skip).
function entryUpdate(e: Entry, sessionId: string): SessionNotification | null;
```

| entry                                        | update                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message` user / assistant                   | `user_` / `agent_message_chunk` (existing behavior)                                                                                                       |
| `script` / `skill-invoke` / `command-invoke` | `tool_call` `{toolCallId: e.id, title, kind:"execute", status:"in_progress"}`                                                                             |
| `result`                                     | `tool_call_update` `{toolCallId: e.script, status: e.exit===0 ? "completed":"failed", content:[{type:"content", content:{type:"text", text: e.output}}]}` |
| `decision` / `observation` / `perms`         | `null`                                                                                                                                                    |

Titles: `script` → `Run script <id>`; `skill-invoke` → `Skill: <script>`;
`command-invoke` → `Task: <program> <args>`.

## Design

### Replay (`loadSession`)

`historyUpdates(log, sessionId)` becomes
`log.map(e => entryUpdate(e, sessionId))` filtered for non-null. It now yields
tool calls + updates alongside messages. (The existing message-only behavior is
subsumed.)

### Live — a `UI`-port hook

The orchestrator produces entries but only has `ctx.ui` (status/show/stream).
Add an optional method to the `UI` port:

```ts
entries?(produced: Entry[]): void;  // "these entries were just appended"
```

- **`acpUI`** implements it: for each **action/result** entry (skipping
  `message` — those already stream live via `ui.stream`), send
  `entryUpdate(e, sessionId)` directly via `conn.sessionUpdate` (discrete, not
  through the token coalescer).
- **CLI/TUI** omit it (optional → no-op; they already show actions as text).

**Call sites (in `agent.ts`'s turn), flagged for grill against the code:**

- After `respond()` produces entries → `ctx.ui.entries?.(produced)` surfaces the
  `script`/`skill-invoke`/`command-invoke` (the `tool_call`).
- The **`result` is appended inside the executor** (`executeScriptProposal`
  etc.), not in `produced`. So after the executor returns, the turn surfaces the
  new `result` from `ctx.log` → `ctx.ui.entries?.([result])` (the
  `tool_call_update`). Keeping both emissions in `agent.ts` avoids spreading the
  hook into every executor.

### Where it lives

`entryUpdate` in `src/frontends/acp.ts` (generalizing `historyUpdates`); the
`entries?` method on the `UI` interface in `context.ts`; the call sites in
`agent.ts`.

## Testing

- **`entryUpdate` by example** (pure, fake entries): each kind → the right
  notification (message chunks; `script`→`tool_call` execute/in_progress;
  `result`→`tool_call_update` completed/failed with output); skipped kinds →
  null.
- **Replay**: a log with a `script` + `result` yields a `tool_call` then a
  `tool_call_update` with the right `toolCallId`/status.
- **Live** (fake `AcpConn`): `acpUI.entries([script])` emits a `tool_call`;
  `acpUI.entries([message])` emits nothing (messages stream);
  `acpUI.entries([result])` emits a `tool_call_update`.
- **Behavior-identical** for CLI/TUI (no `entries` method → unaffected);
  existing suite green. Live check in Zed.

## Success criteria

1. `entryUpdate` covers messages + actions + results, tested; `historyUpdates`
   reuses it.
2. `loadSession` replays tool calls; live actions emit
   `tool_call`/`tool_call_update` via the `UI.entries` hook.
3. CLI/TUI unaffected; full `deno task ci` green.
4. Live check in Zed: an action shows as a tool call with status; a reopened
   thread shows past tool calls.

## Deferred

- **Thinking** → `agent_thought_chunk` (provider-layer reasoning separation).
- Diff/terminal content types; `· read X` status-marker routing.
- Cancellation (`session/cancel`) — separate slice.

## Open for grill / tdd

- Does `result.script` reference the `skill-invoke`/`command-invoke` id (uniform
  pairing) or only a `script` id? Confirm against the runner/executor code.
- Exact `agent.ts` call sites + that the `result` is reliably the last appended
  entry after an executor returns.
- Whether to also emit an initial `pending` `tool_call` at propose-time vs only
  `in_progress` (live "running" indicator granularity).

## Invariants preserved

No change to invariant #1. Tool-call surfacing is **read-only output** to the
editor — it reflects entries already in the log; it spawns nothing and grants no
capability. The runner stays the only exec path.
