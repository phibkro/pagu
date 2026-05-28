# Config-driven pluggable handlers (design)

> Status: **draft 2026-05-29** (brainstorming → to be hardened by grill-with-docs,
> then tdd). Resolves the config-driven pluggability increment of backlog #2 and
> the v1 milestone item of the same name. `ReadonlyExec` (gate-never-widen layer 2)
> is the prerequisite and shipped 2026-05-29.

## Goal

Make the capability handler pipeline user-extensible through configuration, while
preserving the invariant: **the set of handlers is the TCB**. Every handler that can
run must be enumerable, auditable, and type-safe by construction. A plugin is safe by
the same lattice law as role composition — it may gate/narrow but never widen.

## Scope

**In:** Handler module interface, `before-approve` injection slot, config.json +
role-frontmatter declaration, loading in `buildContext`, pipeline insertion for the
three Exec-based capabilities (skill, task, command), TUI startup display.

**Out (v1):** Post-result observers, the write capability (`Proposal` carrier differs;
human gate already mandatory), external package distribution (deferred until API
freeze), a second injection slot.

## Slot: `before-approve`

One named injection point in v1: **`before-approve`** — inserted between the last
per-capability gate and `autoApprove`/`approve`:

```
skill:       [resolveBody, ceilingGate,         ...plugins, autoApprove, run]
run_command: [grammarGate,                       ...plugins, autoApprove, run]
run_task:    [policyGate, taskCeilingGate,       ...plugins, autoApprove, run]
write:       [cage, approve, run]   ← excluded v1; human gate already mandatory
```

At this point in the pipeline `exec.body` and `exec.perms` are fully resolved by the
preceding gates. Plugins see the final `(body, perms)` pair and decide: continue or
halt.

## Handler module interface

A handler is a TypeScript file with three named exports:

```typescript
// .pagu/handlers/slack-notify.ts
// For local handlers, import relative to the repo root. When pagu is
// published to JSR the path will be "jsr:@phibkro/pagu/capability".
import type { ReadonlyExec } from "../src/capability/index.ts";
import type { Flow } from "../src/loop.ts";

export const name = "slack-notify";
export const description = "Posts to #ops-alerts before any net-granted run";

export default async function (exec: ReadonlyExec): Promise<Flow> {
  if (exec.perms.some((p) => /allow-net/.test(p))) {
    await fetch("https://hooks.slack.com/...", {
      method: "POST",
      body: JSON.stringify({ text: `pagu: net run ${exec.id}` }),
    });
  }
  return "continue"; // "done" halts the pipeline — capability does not run
}
```

The `HandlerPlugin` interface (exported from `src/capability/index.ts`):

```typescript
export interface HandlerPlugin {
  name: string;
  description: string;
  fn: Step<ReadonlyExec>;
}
```

**Type safety:** `fn` is `Step<ReadonlyExec>`. The compiler enforces gate-never-widen:
`exec.perms = [...]` and `exec.perms.push(...)` both fail to compile inside a handler.
`Step<ReadonlyExec>` satisfies `Step<Exec>` via contravariance (`Exec ⊆ ReadonlyExec`),
so plugins slot into `Step<Exec>` pipelines without casts.

**Validation at load time:** `buildContext` checks that each loaded module exports
`name: string`, `description: string`, and `default: function`. Any mismatch → fail
loud (throw). A handler that can't be loaded is a broken TCB, not a graceful
degradation.

**Failure semantics:** if a handler's default function _throws_ at runtime (rather than
returning `"done"`), the error propagates to `runTask`'s catch block and shows
`✗ handler <name>: <error>`. The capability does not run. Fail-closed — a broken
handler blocks execution; it does not silently permit it.

## Configuration

Handler paths are declared under `handlers: { before-approve: [...] }`. This wrapping
key is forward-compatible — adding a second slot in a future slice doesn't change the
top-level key structure.

**`config.json`** (system `~/.config/pagu/config.json` or project `.pagu/config.json`):
```json
{
  "handlers": {
    "before-approve": [
      "./.pagu/handlers/audit.ts",
      "./.pagu/handlers/slack-notify.ts"
    ]
  }
}
```

**Role frontmatter** (`.pagu/roles/corporate.md`):
```markdown
---
handlers:
  before-approve:
    - ./.pagu/handlers/compliance.ts
---

This role enables the compliance check handler...
```

Both fold into `ConfigLayer` at `handlers: { beforeApprove: string[] }` (camelCase in
TypeScript; kebab-case `before-approve` in JSON/YAML). Set-union across layers. Paths
are resolved relative to the **declaring file's directory**: a config.json path
resolves against that config.json's parent directory; a role frontmatter path resolves
against the role file's directory (`.pagu/roles/` or `~/.config/pagu/roles/`). Dedup
by resolved absolute path before loading — the same absolute path declared in both a
config.json and a role loads the handler only once.

**Merge law:** same as `allow` paths — set-union in load order, no deduplication
across roles (duplicate paths load the same handler twice; the implementation should
dedup by resolved absolute path). System config handlers fire before project config
handlers; earlier roles before later ones within each scope.

## Loading (`buildContext`)

After the full config stack is resolved, in `src/config/setup.ts`:

```typescript
const handlerPaths = cfg.handlers?.["before-approve"] ?? [];
const activeHandlers: HandlerPlugin[] = [];
// configBase = the declaring file's directory (passed through from the config loader)
for (const handlerPath of dedup(handlerPaths.map(p => resolve(configBase, p)))) {
  const mod = await import(handlerPath);
  if (
    typeof mod.name !== "string" || !mod.name ||
    typeof mod.description !== "string" || !mod.description ||
    typeof mod.default !== "function"
  ) {
    throw new Error(
      `handler ${handlerPath}: must export name (string), description (string), and default (function). Got: ${JSON.stringify({ name: mod.name, description: mod.description, default: typeof mod.default })}`
    );
  }
  activeHandlers.push({ name: mod.name, description: mod.description, fn: mod.default });
}
```

`activeHandlers` is stored on `AgentContext` alongside `activeSkillScripts`. The TUI
and ACP both read it for display.

## Pipeline insertion

The Exec-based executors receive `ctx.activeHandlers` and splice it between the last
per-capability gate and `autoApprove`:

```typescript
const pluginSteps = ctx.activeHandlers.map((h) => h.fn);
// skill:
pipeline([resolveBody, ceilingGate, ...pluginSteps, autoApprove, run])(exec);
// run_command:
pipeline([grammarGate, ...pluginSteps, autoApprove, run])(exec);
// run_task:
pipeline([policyGate, taskCeilingGate, ...pluginSteps, autoApprove, run])(exec);
```

When `activeHandlers` is empty the pipeline is identical to the current code — no
behaviour change, no performance cost.

## TCB enumeration (TUI + ACP)

The active handler set must be visible — "the set of handlers is the TCB" only
means something if the user can audit it.

**TUI startup header** (only shown when handlers are active):
```
pagu — chat, or ask for an action
  provider  ollama · qwen3.5:9b
  reads     /repo
  repo      /repo (auto-approve)
  handlers  slack-notify · compliance-check
  sandbox   sandbox-exec
```

**ACP** — `available_commands_update` or a separate session notification surface the
active handler names so editor clients know what's running.

**Log** — no new entry type needed. A handler that halts produces a `pagu:decision
verdict=reject rationale="handler <name>: <reason>"`, which already appears in the
audit trail. A handler that continues leaves no trace (correct — it's an observer, not
an actor).

## `AgentContext` additions

```typescript
/** Pre-loaded before-approve handlers; empty array when none configured. */
activeHandlers: HandlerPlugin[];
/** Replace the active handler set at runtime (future /handlers TUI command).
 *  v1: stub — present on the interface for forward-compatibility but not wired
 *  to any TUI command yet. Returns { ok: false, message: "not yet implemented" }. */
setHandlers?: (paths: string[]) => Promise<{ ok: boolean; message: string }>;
```

`setHandlers` is optional in v1 — included as a forward-compatibility stub so the TUI
can later add a `/handlers` command analogous to `/roles` and `/skills`.

## Testing

- **Unit** — `HandlerPlugin` shape validation: fixture modules with missing/wrong
  exports confirm fail-loud behaviour. A handler that returns `"done"` on a condition
  confirms the pipeline halts.
- **Integration** — inject a handler directly into `ctx.activeHandlers` in the
  existing capability tests: `activeHandlers: [{ name: "test", description: "...", fn: always_continue }]`.
  Existing tests pass with empty `activeHandlers` (no-op path).
- **Property** — the gate-never-widen invariant: a handler that attempts `exec.perms = [...]`
  fails to compile (type-level test; verified by `deno check`).

## Migration (refactor-under-green)

1. Add `HandlerPlugin` interface and `activeHandlers: HandlerPlugin[]` to
   `src/capability/index.ts` and `AgentContext`. CI green.
2. Add `handlers.beforeApprove: string[]` to `ConfigLayer` and `PaguConfig` in
   `src/config/config.ts`; parse from config.json and role frontmatter in setup.ts.
   CI green.
3. Load handlers in `buildContext`; surface in TUI startup. CI green.
4. Insert `pluginSteps` in skills, tasks executors. CI green.
5. Add unit tests for shape validation and pipeline halt behaviour. CI green.
