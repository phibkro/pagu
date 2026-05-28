# Config-driven pluggable handlers (design)

> Status: **draft 2026-05-29** (brainstorming → grilling → tdd). Resolves the
> config-driven pluggability increment of backlog #2 and the v1 milestone item
> of the same name. `ReadonlyExec` (gate-never-widen layer 2) is the
> prerequisite and shipped 2026-05-29.

## Goal

Make the capability handler pipeline user-extensible through configuration,
while preserving the invariant: **the set of handlers is the TCB**. Every
handler that can run must be enumerable, auditable, and permission-scoped by
construction.

## Scope

**In:** Handler module interface, `before-approve` injection slot, config.json +
role-frontmatter declaration, loading in `buildContext`, hybrid execution model
(in-process or handler-phase subprocess), TUI startup display.

**Out (v1):** Post-result observers, the write capability (`Proposal` carrier;
human gate already mandatory), external package distribution (deferred until API
freeze), a second injection slot.

## Slot: `before-approve`

One named injection point in v1: **`before-approve`** — inserted between the
last per-capability gate and `autoApprove`:

```
skill:       [resolveBody, ceilingGate,         ...handlers, autoApprove, run]
run_command: [grammarGate,                       ...handlers, autoApprove, run]
run_task:    [policyGate, taskCeilingGate,       ...handlers, autoApprove, run]
write:       [cage, approve, run]   ← excluded v1; human gate already mandatory
```

At this point `exec.body` and `exec.perms` are fully resolved. Handlers see the
final `(body, perms)` pair and decide: continue or halt.

## Handler module interface

A handler is a TypeScript file with four named exports:

```typescript
// .pagu/handlers/slack-notify.ts
// Imports for local development. When pagu is on JSR: "jsr:@phibkro/pagu/capability"
import type { ReadonlyExec } from "../src/capability/index.ts";
import type { Flow } from "../src/loop.ts";

export const name = "slack-notify";
export const description = "Posts to #ops-alerts before any net-granted run";

/** Declared permission ceiling. Empty array → runs in-process with orchestrator
 *  permissions. Non-empty → runs as an isolated handler-phase subprocess with
 *  exactly these permissions. */
export const permissions: string[] = ["allow-net=hooks.slack.com"];

/** The handler function — called in-process when permissions is empty,
 *  or called inside the handler-phase subprocess when permissions is non-empty. */
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
  /** Absolute path to the handler file — used for subprocess invocation. */
  path: string;
  /** Declared permission ceiling. Empty = in-process; non-empty = subprocess. */
  permissions: string[];
  /** The handler function — used for in-process execution and as the
   *  subprocess entrypoint (called by phases/handler.ts). */
  fn: Step<ReadonlyExec>;
}
```

**Type safety:** `fn` is `Step<ReadonlyExec>`. The compiler enforces
gate-never-widen: `exec.perms = [...]` and `exec.perms.push(...)` both fail to
compile inside a handler. `Step<ReadonlyExec>` satisfies `Step<Exec>` via
contravariance, so handlers slot into `Step<Exec>` pipelines without casts.

**Validation at load time:** `buildContext` checks that each loaded module
exports `name: string`, `description: string`, `permissions: string[]`, and
`default: function`. Any mismatch → fail loud (throw). A handler that can't be
loaded is a broken TCB.

**Failure semantics:** if a handler's function _throws_ (rather than returning
`"done"`), the error propagates to `runTask`'s catch block:
`✗ handler <name>: <error>`. The capability does not run. Fail-closed.

## Configuration

Handler paths are declared under `handlers: { "before-approve": [...] }` —
nested so future slots slot in without changing the top-level key structure.

**`config.json`** (system `~/.config/pagu/config.json` or project
`.pagu/config.json`):

```json
{
  "handlers": {
    "before-approve": [
      ".pagu/handlers/audit.ts",
      ".pagu/handlers/slack-notify.ts"
    ]
  }
}
```

**Role frontmatter** (`.pagu/roles/corporate.md`):

```markdown
---
handlers:
  before-approve:
    - .pagu/handlers/compliance.ts
---

This role enables the compliance check handler...
```

Both fold into `ConfigLayer.handlers?.["before-approve"]?: string[]`.
`mergeLayer` union-merges the inner array (one extra block alongside `allow` and
`write`). Both `mergeConfig` (JSON) and `toLayer` (role frontmatter) need a
matching nested-array check.

**Path resolution:** paths resolve against the **process cwd** (same as `allow`
paths — `setup.ts` uses `resolve(p)` with no base). Absolute paths always work.
Dedup by resolved absolute path — the same handler appearing in multiple configs
loads once.

## Loading (`buildContext`)

```typescript
const handlerPaths = cfg.handlers?.["before-approve"] ?? [];
const activeHandlers: HandlerPlugin[] = [];
for (const p of dedup(handlerPaths.map(resolve))) {
  const mod = await import(p);
  if (
    typeof mod.name !== "string" || !mod.name ||
    typeof mod.description !== "string" || !mod.description ||
    !Array.isArray(mod.permissions) ||
    typeof mod.default !== "function"
  ) {
    throw new Error(
      `handler ${p}: must export name, description, permissions[], and default fn`,
    );
  }
  activeHandlers.push({
    name: mod.name,
    description: mod.description,
    path: p,
    permissions: mod.permissions as string[],
    fn: mod.default as Step<ReadonlyExec>,
  });
}
```

`activeHandlers` is stored on `AgentContext` alongside `activeSkillScripts`.

## Execution model — hybrid (in-process or handler phase)

The orchestrator decides per-handler based on its declared `permissions`:

```typescript
async function runHandler(
  h: HandlerPlugin,
  exec: Exec,
  ctx: AgentContext,
): Promise<Flow> {
  const orchestratorPerms = new Set(["read", "write", "run", "env"]);
  const needsExtra = h.permissions.some((p) => {
    const flag = p.replace(/^allow-/, "");
    return !orchestratorPerms.has(flag.split("=")[0]);
  });

  if (!needsExtra) {
    return h.fn(exec); // in-process — no cold start, orchestrator permissions
  }
  return spawnHandlerPhase(h, exec, ctx); // isolated subprocess with declared ceiling
}
```

### In-process path

When `permissions` is empty or all declared permissions are already held by the
orchestrator (`read`, `write`, `run`, `env`): call `h.fn(exec)` directly. No
subprocess spawn, no cold start. Type-safety from `Step<ReadonlyExec>`. Use
cases: file-audit logging, local condition checks.

### Subprocess path — `phases/handler.ts`

When `permissions` contains extras (e.g. `allow-net=hooks.slack.com`): spawn a
new short-lived handler phase with exactly the declared permissions. This is a
new phase alongside `phases/respond.ts`, using the same `spawnPhase`
infrastructure.

**`ExecView`** — the serializable subset that crosses the process boundary:

```typescript
export interface ExecView {
  id: string;
  body: string;
  perms: readonly string[];
  title: string;
}
```

**Handler I/O types** — kept in `src/capability/index.ts` alongside `ExecView`,
not in `phases/ipc.ts` (the handler phase has its own lightweight I/O, separate
from the respond-phase `readInput`/`writeOutput` that wraps
`{ entries: Entry[] }`):

```typescript
export interface HandlerPhaseInput {
  handlerPath: string;
  exec: ExecView;
}
export interface HandlerPhaseOutput {
  decision: "continue" | "done";
  rationale?: string;
}
```

**`phases/handler.ts`** (the subprocess entrypoint) — reads/writes raw JSON
directly, not through `phases/ipc.ts`:

```typescript
// effects: handler phase — runs a user handler in an isolated process
// Lightweight I/O: raw JSON on stdin/stdout (not the respond-phase Entry[] wrapper).

const raw = new TextDecoder().decode(
  await Deno.stdin.readable
    .getReader().read().then((r) => r.value ?? new Uint8Array()),
);
const { handlerPath, exec } = JSON.parse(raw) as HandlerPhaseInput;
const mod = await import(handlerPath);

// Minimal ReadonlyExec adapter — ctx is unavailable in the subprocess
const pseudoExec = {
  ...exec,
  ctx: undefined!,
  rationale: "",
  outcome: "loop" as const,
};
const decision: "continue" | "done" = await mod.default(pseudoExec);
console.log(JSON.stringify({ decision } satisfies HandlerPhaseOutput));
```

**`spawnHandlerPhase`** — its own lightweight subprocess spawn, not using
`spawnPhase` (which expects `{ entries: Entry[] }` output):

```typescript
async function spawnHandlerPhase(
  h: HandlerPlugin,
  exec: Exec,
  ctx: AgentContext,
): Promise<Flow> {
  const view: ExecView = {
    id: exec.id,
    body: exec.body,
    perms: exec.perms,
    title: exec.title,
  };
  const input = JSON.stringify(
    { handlerPath: h.path, exec: view } satisfies HandlerPhaseInput,
  );
  const child = new Deno.Command("deno", {
    args: [
      "run",
      "--no-prompt",
      ...ctx.readPaths.map((p) => `--allow-read=${p}`),
      ...h.permissions,
      join(ctx.phaseDir, "handler.ts"),
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  // forward stderr live (handler can emit status via stderr side-channel)
  const drainStderr = async () => {
    for await (const c of child.stderr.pipeThrough(new TextDecoderStream())) {
      ctx.ui.stream?.(c);
    }
  };
  let stdout = "";
  const drainStdout = async () => {
    for await (const c of child.stdout.pipeThrough(new TextDecoderStream())) {
      stdout += c;
    }
  };
  await Promise.all([drainStdout(), drainStderr()]);
  const { code } = await child.status;
  if (code !== 0) throw new Error(`handler ${h.name} exited ${code}`);
  const out = JSON.parse(stdout) as HandlerPhaseOutput;
  return out.decision;
}
```

**Stderr side-channel** — the handler subprocess can write progress to stderr;
the orchestrator's `ui.stream` forwards it live, same as the respond phase.

**Cold start note:** handler subprocesses pay the ~50–100ms Deno cold-start per
invocation. Acceptable for the security gain; the future WASM tier would
eliminate this (handler runs as a WASM module — no process spawn). This is the
natural next tier behind `detectSandbox`.

## TCB enumeration (TUI + ACP)

**TUI startup header** (only shown when handlers are active):

```
pagu — chat, or ask for an action
  provider  ollama · qwen3.5:9b
  reads     /repo
  repo      /repo (auto-approve)
  handlers  audit (in-process) · slack-notify (subprocess: allow-net=…)
  sandbox   sandbox-exec
```

Show the execution mode so the user can audit whether each handler is isolated.

**Log** — no new entry type. A halting handler produces:
`pagu:decision verdict=reject rationale="handler slack-notify: net run blocked"`.
A continuing handler leaves no trace.

## `AgentContext` additions

```typescript
activeHandlers: HandlerPlugin[];
setHandlers?: (paths: string[]) => Promise<{ ok: boolean; message: string }>;
// ↑ v1 stub — returns { ok: false, message: "not yet implemented" }
```

## Testing

- **Unit** — shape validation (missing exports fail loud); in-process handler
  returning `"done"` halts the pipeline; empty `activeHandlers` is a no-op.
- **Integration** — subprocess handler with
  `permissions: ["allow-net=example.com"]` spawns correctly and its decision is
  respected. Use a fixture handler that writes its decision to a temp file for
  assertion.
- **Property** — type-level: `exec.perms = [...]` fails to compile in a handler
  body (verified by `deno check`).

## Migration (refactor-under-green)

1. Add `HandlerPlugin`, `ExecView`, `HandlerPhaseInput/Output` to
   `src/capability/index.ts` and `src/phases/ipc.ts`. Add `activeHandlers` to
   `AgentContext`. CI green.
2. Add nested `handlers["before-approve"]` to `ConfigLayer` in
   `src/config/config.ts`; wire `mergeLayer`, `mergeConfig`, `toLayer`. CI
   green.
3. Load handlers in `buildContext`; surface in TUI startup line. CI green.
4. Add `src/phases/handler.ts` (subprocess entrypoint) + `spawnHandlerPhase`
   helper. CI green.
5. Insert `runHandler` wrapper in skill/task/command executors. CI green.
6. Tests for shape validation, in-process halt, subprocess spawn. CI green.

## Future tier (WASM / microVM)

The hybrid decision point (`needsExtra?`) is the natural slot for a third tier:
`none → in-process`, `net/extra → subprocess`, `full-isolation → WASM/microVM`.
The `spawnHandlerPhase` function becomes `dispatchHandler(tier, h, exec, ctx)`.
Adding the WASM tier means adding a branch; the existing tiers are unchanged.
This maps directly to backlog #5 (scoped-isolation sandbox tiers).
