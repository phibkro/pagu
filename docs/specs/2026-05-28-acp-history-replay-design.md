# ACP history replay on session/load — design (v1)

> Status: hardened via grill-with-docs (2026-05-28); ready for tdd. Grill
> verified the load path (`buildContext({session, cwd})` loads `ctx.log`,
> depends on cwd fix `9e2936f`) and resolved: replay sends **directly** via
> `conn.sessionUpdate` (awaited, message-granular), bypassing the new per-token
> coalescing buffer (`d159484`). Roadmap: CONTEXT.md → Open → "ACP — remaining
> integration work" (history replay). Authored via brainstorming.

## Goal

When an editor reopens a pagu session (ACP `session/load`), the conversation
should reappear. Today `loadSession` rebuilds the context (loads `ctx.log`) but
never re-emits it, so a reloaded Zed thread shows **empty** — the bug observed
live. Fix: replay the loaded conversation as `session/update` notifications.

## Scope (deliberately narrow)

- **Messages only** — replay `message` entries (user + assistant). This
  **matches what live mode already shows** (assistant text via
  `agent_message_chunk`; approvals are resolved, not replayed), so a reloaded
  thread looks like the live one did.
- **Deferred to a dedicated "rich content" slice:** thinking
  (`agent_thought_chunk`) and actions
  (`script`/`result`/`skill-invoke`/`command-invoke` → `tool_call` /
  `tool_call_update`). These are distinct ACP content _types_ that deserve
  special handling (live-stream **and** replay), not lumping into message replay
  — their own brainstorm → grill → tdd cycle. (Supersedes/expands the Open item
  "surface tool calls".) Replaying them requires that tool_call mapping, so they
  don't belong here.

## The model

`loadSession` already loads `ctx.log` (via `buildContext` with `session: id` +
`cwd` — verified: `setup.ts` resolves `sessionPath(base, id)` and
`ctx.log =
loadSession(path).entries`, and the cwd fix `9e2936f` makes `base`
the editor's project). The fix is to map that log to `session/update`
notifications and send them — a **pure mapper + effectful send** (FCIS).

The send goes **directly through `conn.sessionUpdate`, `await`ed per message**
(for ordering). It does **not** route through `acpUI.stream`, which now
_coalesces_ per-token output (`d159484`); replay is **message-granular** (one
update per message), so it bypasses the streaming buffer entirely.

## Design

### `historyUpdates(log, sessionId): SessionNotification[]` — pure

Maps each conversation entry to a replay notification; skips everything else:

- `message` with `role: "user"` → `session/update` `user_message_chunk` (text).
- `message` with `role: "assistant"` → `session/update` `agent_message_chunk`
  (text).
- all other entry kinds (`script`, `result`, `skill-invoke`, `command-invoke`,
  `decision`, `observation`, `perms`) → skipped in v1.

Pure (no I/O), so it's tested by law with a fake log. Lives in
`src/frontends/acp.ts` alongside the other ACP adapters.

### `loadSession` — send the replay

`makeSession` builds the ctx (and loads `ctx.log`); have it return the ctx so
`loadSession` can replay. Then:

```
loadSession(p):
  ctx = makeSession(p.sessionId, p.cwd)
  for u in historyUpdates(ctx.log, p.sessionId): await conn.sessionUpdate(u)
  return {}
```

`newSession` does **not** replay (a fresh session's log is empty).

## Testing

- **Pure law tests on `historyUpdates`** (no I/O):
  `[user "hi", assistant "hey"]` →
  `[user_message_chunk "hi", agent_message_chunk "hey"]` in order; non-message
  entries skipped; empty log → `[]`.
- **Effectful `loadSession`** via the existing fake `AcpConn` (`acp.test.ts`
  pattern): a loaded session emits the mapped `sessionUpdate` calls.

## Success criteria

1. `historyUpdates` exists, pure, law-tested green.
2. `loadSession` replays the conversation messages via `conn.sessionUpdate`.
3. A reopened Zed thread shows the prior user + assistant messages (live check).
4. Full `deno task ci` green; no change to live (non-reload) behavior.

## Deferred

- **Rich content slice**: thinking (`agent_thought_chunk`) + tool calls
  (`tool_call`/`tool_call_update`), both live-streamed and replayed — their own
  cycle.
- Other ACP gaps (slash commands, cancellation) — separate slices.

## Invariants preserved

No change to invariant #1. Replay is **read-only output** to the editor (the log
is already on disk); it spawns nothing and grants no capability. The runner
stays the only exec path.
