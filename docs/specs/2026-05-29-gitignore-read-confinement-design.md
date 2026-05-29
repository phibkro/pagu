# Gitignore read confinement — OS-sandbox masking (design)

> Status: **draft 2026-05-29** (brainstorming → grilling → tdd). Closes the
> gitignore read gap — a v1 security-verification item and a CONTEXT.md "Open"
> item.

## The gap

In repo mode the envelope grants read+write to the whole repo. `.gitignore`'d
paths (`.env`, keys) are derived by `gitignoreDenies()` and applied as
**deny-WRITE only** at runtime — never deny-read, because Deno's
`--deny-read=<child>` breaks `readDir(parent)` (AGENTS.md gotcha).

Consequence: a script in the runner with `--allow-read=<repo>` can
`Deno.readTextFile(".env")`, print it; the stdout auto-returns into the log (the
no-net output gate passes it because the runner had no net); the next
respond-phase turn ships the log — secret included — to the model provider. For
a **remote** provider the secret leaves the machine. "No internet exfil" only
held if the model provider was trusted.

## Approach — OS-level read confinement (the only sound fix)

The Deno-flag approaches are ruled out by the same constraint that created the
gap: you cannot express "read the repo except `.env`" with `--allow-read` /
`--deny-read`. The fix must live **below Deno**, at the OS-sandbox tier, where
the runner's *filesystem view* simply doesn't contain the gitignored paths.
This is enforcement at the actual security boundary (the sandbox), not a
code-level band-aid — consistent with pagu's stance that the boundary is the
runner's Deno perms + OS sandbox, never our code.

### The bar (decided)

Close it **at the OS-sandbox tier**: bwrap (Linux) and sandbox-exec (macOS).
On tier-1-only (no OS sandbox, e.g. Windows or `--no-sandbox`), the gap
persists — **documented** as a known tier-1 limitation, consistent with how
writes/net are already described (tier 2 is best-effort defense-in-depth). No
fragile content-redaction fallback (it would invite false confidence).

### Masking scope (decided)

Mask **all** gitignored paths — consistent with the agent's existing
`handleRead` refusal (which already blocks the agent from reading any gitignored
path). `gitignored ≠ secret` (it includes `node_modules/`, `dist/`), so masking
the whole set may break a `run_task` that legitimately needs a gitignored build
dep. Accepted under security-over-utility; the escape hatch (an explicit
`readable-gitignored` config opt-out) is **deferred until it actually bites** —
not built speculatively, and not replaced by a secrets-pattern heuristic (pagu
avoids heuristics).

## Mechanism

`SandboxScope` (`src/runner/sandbox.ts`) gains a read-mask:

```typescript
export interface SandboxScope {
  writableMounts: string[];
  allowNet: boolean;
  /** Gitignored paths to hide from the sandbox view (read confinement).
   *  isDir drives the bwrap masking primitive; sandbox-exec ignores it. */
  readMask: { path: string; isDir: boolean }[];
}
```

### bwrap (Linux)

After `--ro-bind / /` and the writable mounts, append a mask per path (masks
last, so they overlay the rw repo bind):

- **directory** → `--tmpfs <path>` (an empty tmpfs hides the contents)
- **file** → `--ro-bind-try /dev/null <path>` (reads return EOF → empty string)

`-try` variants tolerate a path that git lists but is since deleted. Nested
entries don't occur — `git ls-files --directory` already collapses an ignored
dir to the dir itself.

### sandbox-exec (macOS)

Append one deny-read rule per path — SBPL handles file or dir uniformly via
`subpath`, and a later `deny` overrides the earlier `(allow default)`:

```
(deny file-read* (subpath "<abs-path>"))
```

`isDir` is unused on macOS.

### Platform behavioural difference (intended)

The two masks differ in *how* the read fails, and that's fine — both achieve
"the secret never reaches stdout":

- **bwrap** (`/dev/null` bind / empty tmpfs): the read **succeeds but returns
  empty** — `Deno.readTextFile(".env")` yields `""`.
- **sandbox-exec** (`deny file-read*`): the read **throws** (`EPERM`) — the
  script errors on that read.

Either way the secret content is absent from the output. Tests assert **"the
secret string does not appear in the run output,"** not "output is empty" —
that invariant holds on both platforms.

### Threading

`ctx.gitignored` (absolute gitignored paths, already computed in `setup.ts`)
flows into the runner:

- `runScript` (`run.ts`) gains `readMask?: string[]`. It classifies each via
  `Deno.statSync` (file vs dir) — the same effectful-shell pattern
  `resolveWritable` already uses — and puts `{ path, isDir }[]` on the scope.
  `sandbox.ts` stays pure (consumes the classified list).
- `cageOnce` **and** `performRun` (`capability/index.ts`) pass `ctx.gitignored`
  as `readMask`. Masking applies in **both** the cage self-test and the real
  run, so a script reads `.env` as empty consistently in rehearsal and for real.

When `kind === "none"` (tier 1), `readMask` is ignored — no masking, gap
persists (the documented limitation).

## Invariants preserved

- **#1** unchanged — the runner is still the only exec path; this only narrows
  what it can *read*.
- **#2 strengthened** — read confinement is added at the OS-sandbox boundary,
  closing the one tier-2 gap CONTEXT.md called out ("reads stay broad at the OS
  layer").
- **CF3 not regressed** — `handleRead`'s agent-read refusal stays; this adds a
  second enforcement layer at the runner.

## Testing

- **Pure** (`sandbox.test.ts`): `wrapForSandbox` with a `readMask` produces the
  expected bwrap args (`--tmpfs` for dir, `--ro-bind-try /dev/null` for file)
  and the expected SBPL `(deny file-read* …)` lines. String assertions on the
  constructed argv/profile.
- **Integration** (the enforcement test — can't be unit-tested): on a platform
  with a sandbox, create a temp git repo with a gitignored `secret.txt`
  containing a known string; run a script via `runScript` (with the mask) that
  reads it; assert the **secret string is absent** from the run output (works
  whether the read returned empty on bwrap or threw on sandbox-exec — see the
  platform difference above). Skip when `detectSandbox()` is `none` (tier-1 — no
  enforcement to test). This is the "you can't unit-test that the sandbox
  actually blocks reads" case from the tdd test-level guidance.

## Files

- `src/runner/sandbox.ts` — `SandboxScope.readMask`; bwrap masking; SBPL deny-read.
- `src/runner/run.ts` — `runScript` `readMask?` opt; statSync classification.
- `src/capability/index.ts` — `cageOnce` + `performRun` pass `ctx.gitignored`.
- Tests: `src/runner/sandbox.test.ts` (pure), an integration test (real sandbox).
- Docs: CONTEXT.md (security tiers — read confinement closed at tier 2; resolve
  the Open item); AGENTS.md (update the `--deny-read` gotcha to note OS-sandbox
  masking now covers it at tier 2); CHANGELOG.

## Migration (one step at a time, CI green between each)

1. `SandboxScope.readMask` + `bwrapArgs`/`sbplProfile` masking; pure tests for
   arg construction. CI green.
2. `runScript` `readMask?` opt + statSync classification; thread into scope. CI green.
3. `cageOnce` + `performRun` pass `ctx.gitignored`. CI green.
4. Integration test (real sandbox masks a gitignored read to empty). CI green.
5. Docs: CONTEXT security tiers, AGENTS gotcha, CHANGELOG.

## Deferred

- `readable-gitignored` config opt-out (re-allow specific gitignored paths for
  the runner) — add only if masking-all breaks a real `run_task` build workflow.
- Tier-1 read confinement (Landlock for finer Linux control without bwrap;
  Windows) — out of scope; the documented gap stands until the OS sandbox is
  present.
