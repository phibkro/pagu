# ACP tool-call surfacing — design (v1)

> Status: **implemented 2026-05-28** (via tdd). One `entryUpdate` mapper
> (messages + actions + results) reused by replay (`historyUpdates`) and live
> (the `UI.entries` hook; acpUI maps action/result, CLI/TUI no-op); the three
> executors emit their `result`, `agent.ts` emits produced actions. Verified
> live: a script-running prompt emits `tool_call: in_progress` →
> `tool_call_update: completed`. Hardened via grill: confirmed
> `result.script === the action entry id` uniformly (skills/tasks/write), so no
> special-casing; live emission at the append sites; `in_progress`-only for v1.
> Grounded in the ACP spec + SDK types. Authored via brainstorming.

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

**Call sites (resolved against the code) — emit at the append site:**

- `agent.ts` after `respond()` → `ctx.ui.entries?.(produced)` surfaces the
  `script`/`skill-invoke`/`command-invoke` (the `tool_call`).
- **Each executor**, right after it `ctx.log.push`es its `result`
  (`skills/execute.ts:135`, `tasks/execute.ts:171`, `write/pipeline.ts:184`),
  calls `ctx.ui.entries?.([result])` (the `tool_call_update`). The executors
  already use `ctx.ui` (status/show), so this is consistent — and it avoids the
  fragile post-hoc "find the last result" search the design first proposed.

### Where it lives

`entryUpdate` in `src/frontends/acp.ts` (generalizing `historyUpdates`); the
`entries?` method on the `UI` interface in `context.ts`; the call sites in
`agent.ts` (produced actions) + the three executors (each emits its `result`).

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

## Resolved by grill

- **Pairing is uniform:** all three executors set `result.script = entry.id`
  (`skills/execute.ts:137`, `tasks/execute.ts:173`, `write/pipeline.ts:186`), so
  `result.script === the action id` for every action kind — no special-casing.
- **Live emission at the append sites**, not a post-hoc search: each executor
  emits its `result` via `ctx.ui.entries` (a port it already uses); `agent.ts`
  emits the produced action entries.
- **`in_progress`-only** status for v1; the separate `pending`-at-propose
  granularity is deferred.

## Invariants preserved

No change to invariant #1. Tool-call surfacing is **read-only output** to the
editor — it reflects entries already in the log; it spawns nothing and grants no
capability. The runner stays the only exec path.
