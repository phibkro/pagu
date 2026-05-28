# Capability front-end — discover / list / registry (design)

> Status: **draft 2026-05-28** (brainstorming → to be hardened by grill-with-docs,
> then tdd). Resolves the front-end half of backlog #6 (`Capability` port —
> discover/list/registry). The execute half shipped 2026-05-28
> (`src/capability/index.ts`; see its companion spec).

## Goal

Remove the 3× dispatch branches in `agent.ts` and the 4× sequential if-blocks in
`respond.ts` by giving each capability a single declared shape — `Capability<Data>`
— that both processes import. Adding a new capability means implementing the
interface and adding one entry to the registry barrel; `agent.ts` and `respond.ts`
become generic dispatchers that never need to change.

This is primarily a **foundation for the SDK North Star** (capabilities as
inspectable values, composable workflows) — not just a cleanup. The `Capability`
object is the unit the workflow IR will compose over.

## Scope

**In:** the `Capability<Data>` interface, registry barrel, per-capability `capability.ts`
files, and the generic dispatch rewrites in `respond.ts` and `agent.ts`.

**Out:** discover/list changes beyond what's required for dispatch (the `data(ctx)`
function IS the discover step for now). True registry introspection, MCP
integration, and plugin loading are later slices.

## The `Capability<Data>` interface

Lives in `src/capability/index.ts` alongside the existing execution substrate
(`Exec`, `cageOnce`, `performRun`, etc.).

```typescript
interface Capability<Data> {
  /** The log entry kind this capability produces — dispatch key. */
  entryKind: string;
  /** The model tool name(s) this capability advertises. Singular for all
   *  current capabilities; an array is possible for future ones. */
  toolName: string;
  /** Id prefix for log entries (e.g. "sk", "ci", "s"). */
  idPrefix: string;

  /** Serializable data sent to the respond subprocess via phase input.
   *  This IS the discover step: the orchestrator calls data(ctx) at turn
   *  time and includes the result in the phase input. */
  data(ctx: AgentContext): Data;

  /** Availability law: legal ∩ environment-present. Controls whether the
   *  tool is advertised to the model this turn. */
  isAvailable(data: Data): boolean;

  /** Build the tool definition from this turn's data. Called in the respond
   *  subprocess only — pure, no effects. */
  toolDef(data: Data): ToolDef;

  /** Parse a model tool-call into a typed log entry. Pure. Called in the
   *  respond subprocess only. */
  toEntry(args: Record<string, unknown>, id: string): Entry;

  /** Execute the log entry. Effectful — orchestrator only. Never called
   *  in the respond subprocess even though the module is imported there. */
  execute(entry: Entry, ctx: AgentContext, opts: TurnOpts): Promise<"stop" | "loop">;
}
```

**`TurnOpts`** — a turn-scoped bag passed to every `execute` call:

```typescript
interface TurnOpts {
  task: string;                          // user's original task (for write's fix loop)
  respond: Responder;                    // re-invoke the respond phase
  showReply: (entries: Entry[]) => void; // display assistant text
}
```

Capabilities that don't need `opts` (skill, task, command) ignore it. `write`
uses all three. This avoids polluting `AgentContext` with turn-scoped closures.

**`AnyCapability`** — the erased form for the registry:

```typescript
type AnyCapability = Capability<unknown>;
```

## Why two separate capabilities for `run_task` / `run_command`

`run_task` and `run_command` have different tool schemas, different arg shapes,
and different approval stories (inferred/declared ceiling vs. fixed grammar
ceiling). Coupling them into one capability with a `toEntry` map and
`ToolDef[]` return was following the implementation accident (same executor,
same entry kind) instead of the conceptual reality.

They are **two separate `Capability<Data>` objects**, both with
`entryKind: "command-invoke"`, both delegating `execute` to
`executeCommandInvocation` (which already routes internally via
`findDefaultRule`). Each has one `toolDef`, one `toEntry`, one `toolName`.

## Per-capability modules

Each action capability gains a `capability.ts` file that composes from the
existing `tool.ts` and `execute.ts` (those files are unchanged):

| Module | File | Data type | toolName |
|--------|------|-----------|----------|
| write | `src/write/capability.ts` | `void` | `"write"` |
| skills | `src/skills/capability.ts` | `{ name, description }[]` | `"invoke_skill"` |
| run_command | `src/tasks/capability.ts` | `CommandRule[]` | `"run_command"` |
| run_task | `src/tasks/capability.ts` | `TaskListing[]` | `"run_task"` |

`buildAllowedTasks` moves from `agent.ts` into `runTaskCapability.data(ctx)`.

## Registry barrel

**`src/capability/registry.ts`** — the single declaration point:

```typescript
import { writeCapability } from "../write/capability.ts";
import { skillCapability } from "../skills/capability.ts";
import { runCommandCapability, runTaskCapability } from "../tasks/capability.ts";

export const actionCapabilities: AnyCapability[] = [
  writeCapability,
  skillCapability,
  runCommandCapability,
  runTaskCapability,
];
```

Adding a new capability = implement `Capability<Data>`, add one line here.
`agent.ts` imports from this barrel and **never changes for new capabilities**
(generic entryKind dispatch). `respond.ts` still needs a one-line pairing per
capability (capability object ↔ phase input field) until open item 3 lands.

## `read`'s special status

`read` is **not** in the action registry. It operates entirely within the respond
subprocess: model calls it, subprocess fetches file content, returns it as a tool
result, conversation loop continues. No log entry is dispatched to the orchestrator.
`readToolDef` stays hardcoded in `respond.ts`, always advertised.

`read` could implement a `ReadCapability` interface for symmetry in a future slice,
but that is speculative — leave it as-is.

## Phase input changes

The orchestrator builds phase input by calling `capability.data(ctx)` for each
action capability. Named fields in `PhaseInput` stay the same (backward-compatible
with existing sessions); they are now populated by the capability objects rather
than ad-hoc helpers:

```typescript
const phaseInput = {
  // ... existing fields ...
  skillScripts:   skillCapability.data(ctx),
  allowedTasks:   runTaskCapability.data(ctx),
  commandRules:   runCommandCapability.data(ctx),
  // write and read have no dynamic data
};
```

## Respond subprocess changes (`src/phases/respond.ts`)

The capability objects are imported directly (same objects the orchestrator uses).
Phase input fields are named, so each capability is explicitly paired with its
data — this is the seam described in open item 3:

```typescript
// Imported from their source modules (same objects as the orchestrator's registry).
import { writeCapability }                        from "../write/capability.ts";
import { skillCapability }                        from "../skills/capability.ts";
import { runCommandCapability, runTaskCapability } from "../tasks/capability.ts";

// Named-field pairing: capability object ↔ its slice of the phase input.
const capData: Array<{ cap: AnyCapability; data: unknown }> = [
  { cap: writeCapability,      data: undefined },
  { cap: skillCapability,      data: input.skillScripts ?? [] },
  { cap: runCommandCapability, data: input.commandRules ?? [] },
  { cap: runTaskCapability,    data: input.allowedTasks ?? [] },
];

const tools = [
  readToolDef,
  ...capData
    .filter(({ cap, data }) => cap.isAvailable(data))
    .map(({ cap, data }) => cap.toolDef(data)),
];
```

The `converse()` if-chain (4 blocks → 1 loop):

```typescript
// Find the first action tool call (priority order matches current if-chain order)
const match = capData
  .map(({ cap }) => ({ cap, call: res.toolCalls.find(c => c.name === cap.toolName) }))
  .find(({ call }) => call != null);

if (match) {
  const { cap, call } = match;
  const n = out.filter(e => e.kind === cap.entryKind).length + 1;
  const id = `${cap.idPrefix}${n}`;
  if (res.content) out.push({ kind: "message", role: "assistant", text: res.content });
  out.push(cap.toEntry(call.args, id));
  break;
}
```

Note: `capData` is a parallel structure to the registry because phase input fields
are named (not a generic array). This is an acknowledged seam — see Open items.

## Orchestrator dispatch changes (`src/agent.ts`)

The 3 dispatch branches collapse to a registry lookup:

```typescript
import { actionCapabilities, isActionEntry } from "../capability/registry.ts";

// In the turn Step:
const action = produced.findLast(isActionEntry);
if (!action) return "done"; // pure chat turn

const cap = actionCapabilities.find(c => c.entryKind === action.kind);
// cap is always found if respond + orchestrator share the same registry
const outcome = await cap.execute(action, ctx, { task, respond, showReply });
return outcome === "stop" ? "done" : "continue";
```

`isActionEntry` is a new type guard in `registry.ts` that returns true for
`script | skill-invoke | command-invoke` — the union of all action entry kinds.

## Open items (flagged for grill-with-docs)

1. **`TurnOpts` vs. `AgentContext` pollution** — `TurnOpts` is the chosen
   approach (turn-scoped bag, third arg to `execute`). Alternatives:
   nullable turn-state fields on `AgentContext`, or deriving `task` from
   `ctx.log`. Grill should confirm `TurnOpts` is the cleanest seam.

2. **Naming overload** — "capability" now has three meanings in the codebase:
   (a) the agent's tools (the capability ladder), (b) the execution substrate
   (`src/capability/`), (c) the new `Capability<Data>` interface. Grill should
   confirm the terminology is consistent with `docs/CONCEPTS.md` and
   `AGENTS.md`, or propose a rename (e.g. `CapabilityDef`, `Cap`, `Tool`).

3. **Phase input seam** — `capData` in `respond.ts` is a parallel structure
   to the registry because phase input fields are named. A future slice could
   replace named fields with a generic `capabilities: { name, data }[]` array,
   making the coupling explicit. Not load-bearing now.

4. **Dispatch ambiguity** — `run_task` and `run_command` share `entryKind:
   "command-invoke"`. The orchestrator's `find` returns whichever appears
   first in `actionCapabilities`. Since both delegate to `executeCommandInvocation`,
   this is correct but fragile — a future capability with the same entry kind
   would silently shadow. Grill should confirm this is acceptable, or propose
   dispatching on `toolName` instead (requires adding `tool?` to
   `CommandInvocationEntry` — a log format change).

## Migration plan (refactor-under-green)

1. Add `Capability<Data>`, `TurnOpts`, `AnyCapability`, `isActionEntry` to
   `src/capability/index.ts`. CI green.
2. Add `src/write/capability.ts` with `writeCapability`. Wire `respond.ts`
   and `agent.ts` to use it for write only. CI green.
3. Add `src/skills/capability.ts` with `skillCapability`. Wire. CI green.
4. Add `src/tasks/capability.ts` with `runCommandCapability` +
   `runTaskCapability`. Wire. CI green.
5. Create `src/capability/registry.ts` and switch `respond.ts` / `agent.ts`
   to import from it. Remove `buildAllowedTasks` from `agent.ts`. CI green.

## Testing

- Each `capability.ts` gets unit tests for `data`, `isAvailable`, `toolDef`,
  `toEntry` — all pure, no subprocess needed.
- A golden-output test: assemble the tool list via the registry and assert it
  matches what the current explicit construction produces.
- `isActionEntry` gets unit tests.
- Existing suite stays green throughout (refactor-under-green, one capability
  at a time per migration plan).
- Live-verify all four action capabilities after step 5.
