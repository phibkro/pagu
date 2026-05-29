# Reasoning tokens + read markers — typed stream channels (design)

> Status: **hardened 2026-05-29** (brainstorm → grill → tdd-ready). The "ACP
> thinking tokens + read markers" v1 item. Separates the model's reasoning from
> its answer and surfaces each appropriately per frontend, via a typed live
> stream channel. Scoped to `<think>`-tag reasoning (ephemeral); structured
> reasoning providers are deferred (see Deferred — a docs finding).

## Goal

Surface model **reasoning** distinctly from its **answer** — ACP maps reasoning
to `agent_thought_chunk` (vs `agent_message_chunk`), the TUI dims it — plus make
`· read X` **activity markers** a first-class channel. Reasoning is
**display-only / ephemeral**: shown live, never stored in the log, never re-sent
to the model.

## Current reality

The live display side-channel is a **single undifferentiated text stream**:
`parseStream` → `onToken(content)` → respond.ts writes raw text to **stderr**
(mixed with `· read X` markers) → `spawnPhase` drains stderr → `agent.ts` →
`ctx.ui.stream(text)` → ACP coalesces into `agent_message_chunk` / TUI prints.
Nothing downstream can tell "this chunk is reasoning." No reasoning parsing
exists.

## Scope decision (a docs finding — see Sources)

Official docs revealed that **Anthropic extended thinking and DeepSeek
`reasoning_content` both require reasoning to be sent back _unchanged_ across
tool-call continuations** (Anthropic: the signed `thinking` block; DeepSeek:
`reasoning_content`) — else a 400. (No tool call between turns → reasoning is
droppable.) pagu is **tool-heavy** (every capability is a tool call) and the
respond loop continues after each, so ephemeral structured-reasoning would 400
mid-loop on those providers. Correct support needs **preserve-and-resend** (+
Anthropic signatures) through the message loop and across phases via the log.

Therefore:

- **In scope now:** `<think>…</think>` inline tags (qwen/deepseek-r1 **via
  Ollama**, the local default). These carry no resend protocol — stripping them
  never 400s — so they are **ephemeral-safe**. High value, clean.
- **Deferred:** `reasoning_content` (DeepSeek/OpenRouter) and Anthropic
  `thinking` — they need reasoning-preservation (resend + signatures), which
  ties to a richer underlying log structure (a separately-noted future item).

## Decisions (resolved in brainstorming)

1. **Channel mechanism = typed stream frames (NDJSON over stderr).** Not in-band
   sentinels (fragile), not batch-only (loses live reasoning).
2. **Reasoning is ephemeral** — live display only; not a log entry, not re-sent.
   (Future: persist outside the main log via a richer structure with the
   turn-array as a presentation layer — out of scope.)
3. **Sources = `<think>` only now**; structured reasoning deferred (the docs
   finding above).
4. **Markers → `agent_thought_chunk`** on ACP (agent _activity_ meta, keeping
   the answer clean), dimmed in the TUI.

## The typed stream-frame protocol

A shared type for live display chunks (in `phases/ipc.ts` or a new
`phases/stream.ts`):

```typescript
export type StreamChannel = "content" | "reasoning" | "marker";
export interface StreamChunk {
  channel: StreamChannel;
  text: string;
}
```

End-to-end seam changes:

- **respond.ts** stops writing raw text to stderr; it writes **one NDJSON line
  per chunk**: `Deno.stderr.write(enc(JSON.stringify(chunk) + "\n"))`. Content
  tokens → `content`; in-`<think>` text → `reasoning`; the `· read X` lines →
  `marker`. (`JSON.stringify` escapes newlines, so each frame is exactly one
  line.)
- **spawnPhase** today drains stderr through `TextDecoderStream` (raw chunks);
  the design pipes it `TextDecoderStream → TextLineStream` (from `@std/streams`,
  already a dep and used this way in `chat.ts`) so it reads **whole lines**.
  Each line that parses as a `StreamChunk` → a new typed `onStream(chunk)`
  callback; lines that **don't** parse (genuine diagnostics — Deno warnings,
  errors) are accumulated as before for the `phase exited N: <stderr>` message.
  So real error output still surfaces; only frames are demuxed.
- **`UI.stream`** widens to
  `stream?(text: string, channel?: "content" |
  "reasoning" | "marker")` — an
  **inline union**, not the named `StreamChannel`. `UI` is a **frozen public
  export** (`src/mod.ts`); adding an _optional_ param is backwards-compatible
  (existing `stream: (chunk) => …` implementers and `stream(text)` callers still
  satisfy it; the floor test checks `{name, kind}`, and `UI` stays `interface`).
  Keeping the union inline avoids growing the frozen surface with a new named
  type — `StreamChunk`/`StreamChannel` stay **internal** to `phases/`.
- **agent.ts** wires `onStream: (c) => ctx.ui.stream?.(c.text, c.channel)`.

Carries no capability (just `{channel, text}`, display-only) — invariant #1
untouched; the side-channel stays a display affordance. The frozen public API
grows only by a backwards-compatible optional param on `UI.stream` (no new
public export, no floor-manifest change).

## Provider parsing — the `<think>` splitter

- `chat(cfg, msgs, tools, onToken?, onReasoning?)` gains an `onReasoning` sink.
- A pure, stateful **`ThinkSplitter`** (`providers/think.ts`): feed it content
  text (token-by-token or whole), it tracks `<think>`/`</think>` open-close
  **across token boundaries** (a tag can split, e.g. `<th`+`ink>`) and yields
  content-vs-reasoning segments. Pure logic, tested by example.
- `parseStream` (OpenAI/streaming) runs each content delta through the splitter
  → content via `onToken`, in-`<think>` text via `onReasoning`. The accumulated
  `ChatResponse.content` **excludes** `<think>` (ephemeral — never persisted).
- `parseBuffered` strips `<think>` from content with the same splitter
  (reasoning dropped — buffered has no live sink; an edge, since respond always
  streams).
- `chatAnthropic` **unchanged** — Anthropic content has no `<think>` (native
  thinking isn't requested); deferred.

No `ChatResponse.reasoning` field, no Anthropic `thinking` param, no
`reasoning_content` delta handling — all deferred.

## Rendering per frontend

- **respond.ts** maps the provider sinks to frames: `onToken`→`content`,
  `onReasoning`→`reasoning`, the `· read X` lines→`marker`.
- **ACP** (`acpUI`) — the coalescer becomes **per-channel** (separate buffers,
  so reasoning and content don't merge into one notification):
  - `content` → `agent_message_chunk` (the answer).
  - `reasoning` → `agent_thought_chunk`.
  - `marker` → `agent_thought_chunk` (activity meta, keeping the answer clean).
  - _Intended:_ per-channel buffers preserve order **within** a channel but not
    strictly **across** channels at the ACP boundary (a reasoning chunk between
    two content chunks may flush after the content) — fine, since editors render
    thoughts and messages in separate regions. `show()` flushes all channel
    buffers first to keep discrete output ordered.
- **TUI** — its `stream` consumer gains the channel: `content` normal,
  `reasoning` + `marker` **dimmed** (existing `dim()`).
- **CLI** (one-shot) — has **no** `ui.stream` (it's batch: the answer is shown
  from the returned message entry after the turn), so all live frames are no-ops
  there and reasoning is simply absent. No CLI change needed.

## Invariants preserved

- **#1** — reasoning/markers are display-only; the stream frame carries no
  capability. The runner/gate are untouched.
- **No-exfil output gating** — reasoning is model output shown live, like
  content tokens; it never enters the persisted log or the next prompt
  (ephemeral), so it can't be re-sent or stored.

## Testing

- `think.test.ts` — the splitter by example: tag split across tokens; multiple
  `<think>` blocks; no-tag passthrough; unclosed tag (everything after `<think>`
  is reasoning); `</think>` mid-token.
- `chat.test.ts` — `parseStream` routes `<think>` content to `onReasoning`, the
  answer to `onToken`, and `ChatResponse.content` has no `<think>`.
- `spawn` stream-frame round-trip — a frame line → typed `onStream(chunk)`; a
  non-frame line → accumulated diagnostic (and still surfaced in the exit
  error).
- `acpUI` — `reasoning`/`marker` → `agent_thought_chunk`, `content` →
  `agent_message_chunk`; per-channel coalescing doesn't merge channels.

## Files

- `src/providers/think.ts` (new) + `think.test.ts` — the splitter.
- `src/providers/chat.ts` — `onReasoning` sink; splitter wiring in
  `parseStream`/`parseBuffered`; `chat.test.ts`.
- `src/phases/stream.ts` (new) — `StreamChannel`/`StreamChunk` (or in `ipc.ts`).
- `src/phases/spawn.ts` — frame demux + `onStream`; non-frame diagnostics.
- `src/phases/respond.ts` — emit frames (content/reasoning/marker).
- `src/agent.ts` — wire `onStream` → `ctx.ui.stream(text, channel)`.
- `src/context.ts` — `UI.stream` gains the `channel` arg.
- `src/frontends/acp.ts` — per-channel coalescer + thought/message mapping.
- `src/frontends/tui.ts` — dim reasoning/marker.
- Docs: `CONTEXT.md` (v1 row, the side-channel description), `CHANGELOG.md`.

## Migration (one step at a time, CI green between each)

1. `ThinkSplitter` (`providers/think.ts`) + pure tests. CI green.
2. `chat.ts`: `onReasoning` sink + splitter in `parseStream`/`parseBuffered`;
   tests assert `<think>`→reasoning, content clean. CI green.
3. `StreamChunk` type + `spawnPhase` frame demux (`onStream`) + diagnostics;
   round-trip test. CI green (respond still emits content only until step 4).
4. respond.ts emits typed frames (content/reasoning/marker); agent.ts wires
   `onStream`; `UI.stream` channel arg. CI green.
5. ACP per-channel coalescer (thought/message) + TUI dim + CLI. CI green.
6. Docs.

## Deferred

- **Structured reasoning** — `reasoning_content` (DeepSeek/OpenRouter) +
  Anthropic extended `thinking`. Both require reasoning **preserved and re-sent
  unchanged across tool-call continuations** (Anthropic: the encrypted
  `signature`), or the provider 400s — incompatible with pagu's tool-heavy loop
  under the ephemeral model. Needs reasoning-preservation through the message
  loop and across phases.
- **Richer log structure** — persist reasoning outside the user-facing
  append-only turn array (a more sophisticated underlying structure with the
  inspectable turn-array as a presentation layer). The enabler for the above.
- **CLI reasoning rendering** — beyond drop/dim, if a one-shot use wants it.

## Sources (docs checked)

- Anthropic — Extended thinking: `thinking` content blocks must be passed back
  unchanged with their `signature` during tool-result continuations.
- DeepSeek — Reasoning Model / Thinking Mode: `reasoning_content` must be passed
  back on tool-call turns (else 400); dropped/ignored otherwise.
