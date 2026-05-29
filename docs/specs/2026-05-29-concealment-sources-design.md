# Concealment sources — split discovery from policy (design)

> Status: **shipped 2026-05-29** (brainstorm → grill → tdd; commits
> `008d856`..`f5fbaaa`, 295 tests green). Generalizes the gitignore read
> confinement ([2026-05-29-gitignore-read-confinement-design.md]) from a single
> git-derived set into a source-neutral **concealment** concept fed by multiple
> sources.

## The conflation

The gitignore read-confinement feature wired a single git-derived set
(`gitignoreDenies()`) through the whole stack under the name `gitignored`
(`ctx.gitignored`, `liveGitignored` in setup.ts, `isGitignored` in respond.ts).
That set drives **both** consumers: the agent read-tool refusal (CF3,
respond.ts) and the runner OS-sandbox mask (capability/index.ts).

This baked the **discovery source** (git) into the **policy** (what to hide).
Two distinct concerns are tangled:

- **Source / discovery** — _where do candidate paths come from._ `.gitignore` is
  one source (and a proxy: it includes `node_modules`/`dist`, and a repo may
  _not_ ignore a tracked secret, or you may not be in a repo at all).
- **Policy / concealment** — _what pagu should hide_ from the runner and the
  agent. This should be expressible explicitly, independent of git.

`.gitignore`-based auto-hide is really **VCS support**: one source among
several, auto-on in repo mode but togglable.

## Decisions (resolved in brainstorming)

1. **Default secret list — on by default** (security-by-default). Convention
   says env files / keys contain secrets; exposing them to the agent is the
   breach. Applied via the OS-sandbox mask (a sound boundary), **not** content
   redaction. This does **not** contradict the prior spec: its "false
   confidence" caution was aimed at the rejected _content-redaction_ method, and
   its "avoid heuristics" note was about not _narrowing_ the gitignore mask to a
   heuristic guess. A path-glob default that is _additive_ and
   _sandbox-enforced_ is neither. Consequence: concealment now applies **outside
   repo mode too** (today non-repo runs conceal nothing) — a deliberate behavior
   change.
2. **gitignore-style globs** (matched via `@std/path` `globToRegExp`) for the
   `hide`/`reveal` lists — same syntax as the VCS source, no ReDoS, works
   without git (needed outside repo mode). Not full regexp; not literal-only.
3. **Concealment implies write-protection** (unified). Every concealed path is
   also write-denied where enforceable: tier-1 `--deny-write` (safe —
   `--deny-read` is what breaks `readDir`, not `--deny-write`) + the tier-2 mask
   covers read+write. "Hidden" means the runner shouldn't read _or_ clobber it.
4. **Build the reveal opt-out now** (not deferred). Default-on concealment
   raises the over-hide rate (a legit `run_task` needing `node_modules`, or
   "read my `.env` to load config"), so the release valve ships with the
   feature.

## Concept & naming (→ `docs/CONCEPTS.md`)

- **hide** — the policy verb. Config keys `hide` (glob list) and `reveal` (glob
  opt-out). The user-facing surface.
- **source** — where hidden paths come from: the **VCS source** (gitignore), the
  **config source** (`hide` globs), the **default-secrets source** (built-in
  globs).
- **conceal / Concealment** — the internal unified set the sources fold into.
- **mask** — the mechanism (unchanged: the runner's `readMask` bwrap/sbpl
  primitive).

Chain: you **hide** files → sources feed the **Concealment** → the sandbox
**masks** them and the agent's read tool refuses them.

## Module — `src/permissions/concealment.ts` (pure)

Joins `gitignore.ts` in the permissions layer. Pure: composes sources, applies
reveal-subtraction, answers two queries. The git call + FS-walk live in the
effectful shell (setup.ts), mirroring how `sandbox.ts` stays pure while `run.ts`
does `realPathSync`/`statSync`.

```typescript
export interface Concealment {
  /** Is this absolute path hidden? (a hide source matches ∧ not revealed) */
  conceals(absPath: string): boolean;
  /** Concrete paths to mask in the OS sandbox (+ derive tier-1 --deny-write). */
  maskPaths(): string[];
}

export interface ConcealmentSpec {
  vcsPaths: string[]; // concrete, from git (already enumerated)
  hideGlobs: string[]; // config `hide`
  secretGlobs: string[]; // default-secrets (on unless disabled)
  revealGlobs: string[]; // config `reveal` — subtracts
  roots: string[]; // read-scope roots — globs match scope-relative paths
  enumerated: string[]; // FS-walk results for the globs (concrete paths)
}

export function buildConcealment(spec: ConcealmentSpec): Concealment;
```

The `conceals` predicate (lazy, pure) is reconstructible from the spec _without_
`enumerated` — respond only needs the predicate. `maskPaths` needs `enumerated`.

## Sources & glob mechanism

### The read-refusal / mask asymmetry

```
conceals(p) = (vcsMatch(p) ∨ hideGlobMatch(p) ∨ secretGlobMatch(p)) ∧ ¬revealMatch(p)
```

- `vcsMatch` — exact-or-nested under a git-enumerated path (today's
  `isGitignored` logic).
- glob matches — **gitignore-compatible**, not naive `globToRegExp`. A naive
  `globToRegExp(".env")` anchors to the literal `.env` and would never match
  `/repo/.env` — so `.env`/`*.pem` would silently conceal nothing. Define the
  semantics like `.gitignore` entries, matched against the path **made relative
  to the scope root** (the read-scope root the path lives under):
  - pattern with **no `/`** → basename-at-any-depth: normalize to `**/<pattern>`
    (so `*.pem` → `**/*.pem`);
  - pattern with a **leading `/`** → anchored to the scope root;
  - `**` → any depth. Implement as
    normalize-then-`globToRegExp(p, { globstar: true })`, test against the
    scope-relative path. One mental model: config globs behave like `.gitignore`
    lines, matching the VCS source's semantics.
- reveal wins — any reveal-glob match un-conceals (same matching semantics).

This is what the **respond read-refusal** calls per requested path. Being lazy,
it covers files created mid-run and needs no filesystem walk.

**`maskPaths()`** needs concrete paths up front (bwrap binds over a real path):

- VCS paths come concrete from git.
- Glob sources are **expanded to concrete paths** at setup via a **two-source
  enumeration** (keeps startup bounded — the walk must not descend
  `node_modules` on every run):
  - **In repo mode** — list candidates with
    `git ls-files --cached --others
    --exclude-standard` (fast; git-ignored
    files are already VCS-masked, so they need no glob match) and test each
    against the globs. No manual walk.
  - **Outside a repo** (no git) — recursive `Deno.readDir` (not `@std/fs` — it's
    not in the import map and invariant #5 prefers no new dep for a trivial
    walk) over the read scope, with a small built-in **skip-list** of heavy dirs
    (`.git`, `node_modules`, `target`, `dist`) so a walk of `.`/`$HOME` stays
    bounded.
- **Gitignored directories** arrive from the VCS source as dir paths (git's
  `--directory` collapse) → masked whole via tmpfs (covers new files inside);
  run.ts's `statSync` classifies dir-vs-file for the tmpfs-vs-`/dev/null`
  decision. **Config/secret globs match files** (the walk pushes matching files,
  descends dirs). Trailing-slash _config_ dir-globs (`secrets/`) masking a whole
  directory are **deferred** (see Deferred); the default-secrets list is all
  file globs, so this gap doesn't touch the security-by-default path.

### The mid-run gap (accepted, documented)

A file _created during the run_ matching a file-glob isn't in `maskPaths()`
(walked at setup), so the runner could read it. Low-risk: the threat is exfil of
_pre-existing_ secrets; a mid-run-created file's content originated in the run
itself (anything it read to produce it was already masked). Dirs don't have this
gap (tmpfs covers new children).

### Default-secrets starter list

Conservative, documented as defense-in-depth, user-extensible via `hide`:

```
.env  .env.local  .env.*.local  *.pem  *.key  id_rsa  id_ed25519
*.p12  *.pfx  .npmrc  .netrc
```

Deliberately **not** `.env.*` (would hide `.env.example` templates) — `reveal`
handles edge cases.

## Config schema & merge law

Four flat fields on both `PaguConfig` and `ConfigLayer` (config.ts) — flat, not
a nested object, so they slot into the existing monoid with no new merge code
(the property-tested laws keep holding):

```typescript
hide?: string[];          // glob conceal patterns       → unionLists (grant-union)
reveal?: string[];        // glob un-conceal patterns     → unionLists (grant-union)
hideSecrets?: boolean;    // default true (built-in list) → scalar right-bias
hideGitignored?: boolean; // default true in repo mode    → scalar right-bias (VCS toggle)
```

- `hide`/`reveal` join `unionLists` (like `allow`/`write`/`allowedTasks`): a
  role can _add_ hide patterns; reveal accumulates the same way. Set-union is
  the right law — concealment grants compose.
- `hideSecrets`/`hideGitignored` right-bias like `advisor?: boolean` — last
  layer wins, so a project config or role can flip them off. `DEFAULTS` seeds
  both `true`; `hideGitignored` is moot outside repo mode.
- `parseLayer` validates: `isStringArray` for the lists, boolean for the toggles
  (mirrors `allowedTasks`/`advisor`).

**CLI flags** — a thin interface onto the same `cli` `ConfigLayer` (folded last,
so flags win), mirroring the existing `--allow`/`--write`/`--no-sandbox`
patterns in `makeCommand`/`parseArgs`:

```
--hide <glob:string>        (collect: true)  → cli.hide
--reveal <glob:string>      (collect: true)  → cli.reveal
--no-hide-secrets                            → cli.hideSecrets = false
--no-hide-gitignored                         → cli.hideGitignored = false
```

The two `--no-*` flags follow `--no-sandbox` (cliffy delivers them as
`hideSecrets: false` / `hideGitignored: false`); `parseArgs` sets the `cli`
field **only when the flag is present**
(`if (options.hideSecrets === false) …`), so an absent flag leaves no opinion
and `DEFAULTS`/config decide. `--hide`/`--reveal` collect like
`--allow`/`--role`. Useful one-offs: `--reveal node_modules` to let a single run
read a build dep, `--no-hide-secrets` to debug.

## Wiring & data flow

**Setup-time** (`applyRoles`, setup.ts) — build concealment once per
role-resolution:

1. Effectful shell gathers source inputs: `vcsPaths` = `gitignoreDenies(repo)`
   when `hideGitignored && repo`; `hideGlobs` = `effective.hide`; `secretGlobs`
   = `hideSecrets ? DEFAULT_SECRETS : []`; `revealGlobs` = `effective.reveal`.
   Enumerate glob→concrete via the two-source enumeration (git `ls-files` in
   repo mode; skip-list `Deno.readDir` walk outside).
2. `concealment = buildConcealment(spec)` (pure).
3. Derive three things:
   - `ctx.concealment` — the orchestrator-side object (replaces
     `ctx.gitignored`).
   - `denyPaths = concealment.maskPaths()` →
     `buildEnvelope({read, write, deny:
     denyPaths})` for the tier-1
     `--deny-write` flags **and** auto-approve gating (decision 3).
     **`buildEnvelope`/`policy.ts` stops calling git directly**; `gitignore.ts`
     becomes one concealment _source_. Cleaner layering. (Note: the read-deny
     was found vestigial for gating in repo mode — the broad
     `--allow-read=<repo>` already covers a gitignored path, so a read of it
     never surfaces as a discovered perm. The _write_-deny is what matters for
     gating.)
   - The serializable concealment **spec** for IPC.

**Consumers** (retiring `gitignored`/`isGitignored`/`liveGitignored`):

- **respond.ts**: `PhaseInput.gitignored: string[]` →
  `PhaseInput.conceal:
  ConcealmentSpec`; respond rebuilds
  `buildConcealment(spec).conceals(path)` (it needs only the lazy predicate, not
  `maskPaths`) — replaces `isGitignored`.
- **capability/index.ts**: `readMask: ctx.concealment.maskPaths()` at both call
  sites (cageOnce + performRun).
- **run.ts**: **unchanged** — `maskPaths()` returns concrete path strings;
  run.ts keeps the load-bearing `realPathSync`/`statSync` classify-and-skip. No
  churn to the just-shipped masking.

## Invariants preserved

- **#1** unchanged — still only narrows what the runner reads/writes.
- **#2 / CF3** — the agent read-refusal and the OS-sandbox mask both stay; this
  generalizes their _input_ from one git source to several, and adds explicit
  config + default-secrets sources.
- **Security over utility** — default-on concealment + write-protection; the
  `reveal` list is the bounded escape hatch.
- **Permission-lattice law (CONCEPTS.md)** — concealment denies are a
  _subtractive hiding overlay within `allow`_, distinct from the lattice's hard
  `⋃ denies`. `reveal` lifts only this overlay, and only within `allow` (which
  is enforced independently via the envelope + Deno `--allow-*`), so it **never
  widens the envelope** — "composition can only tighten, never silently widen"
  is preserved. CONCEPTS.md's lattice section is updated to name the two deny
  kinds.

## Testing

**Pure (`concealment.test.ts`) — the bulk:**

- _Example_: `conceals` vcs exact/nested; glob match (`.env` matches by basename
  at any depth, `.env.example` does **not**, `*.pem` matches `foo.pem`,
  leading-`/` glob anchored to root); reveal precedence (matches both `hide` and
  `reveal` → not concealed; reveal lifts even a vcs match).
- _Property_ (set-algebra laws, no oracle trap): **reveal dominates**
  `∀p,
  revealMatch(p) ⟹ ¬conceals(p)`; **monotonicity** (more `hide` never
  shrinks the set; more `reveal` never grows it); **empty identity**
  (`buildConcealment(∅)` conceals nothing).

**Config merge (`config.test.ts`):** extend the monoid-law generators to include
the four new fields (union for lists, right-bias for toggles); example: `hide`
unions across layers, a role flips `hideSecrets` off.

**Effectful shell (integration, real FS):** the enumeration against a real temp
tree — repo mode finds glob matches via `git ls-files` (and ignored files don't
need re-matching); non-repo mode walks with the skip-list (doesn't descend
`node_modules`), classifies dir-vs-file.

**Enforcement (real sandbox, extends `run.test.ts`):** a **config-hidden,
non-gitignored** secret is masked by the runner (secret absent from output) —
proving the chain for a source other than git; a **revealed** path stays
readable. Skip at tier `none`.

**Respond refusal:** the predicate rebuilt from the IPC spec refuses a
glob-matched path the agent requests — including one _not_ pre-enumerated,
proving lazy matching.

## Files

- `src/permissions/concealment.ts` (new) — `Concealment`, `ConcealmentSpec`,
  `buildConcealment`, `DEFAULT_SECRETS`; pure.
- `src/permissions/gitignore.ts` — stays the VCS source (concrete paths), now
  called from the concealment shell in setup.ts, not from policy.ts.
- `src/permissions/policy.ts` — `buildEnvelope` takes explicit write-`deny`
  scopes (from `concealment.maskPaths()`) instead of calling git → becomes
  **pure** (update the `// pure:` header; the layer checker R4 verifies the
  claim). Envelope `deny` is write-only now (read-conceal moved entirely to
  `ctx.concealment`; the read-deny was vestigial for gating).
- `src/config/config.ts` — `hide`/`reveal`/`hideSecrets`/`hideGitignored` on
  `PaguConfig`+`ConfigLayer`; `mergeLayer`/`parseLayer`; `DEFAULTS` seeds
  toggles.
- `src/config/setup.ts` — build concealment (git + FS-walk enumeration shell);
  `ctx.concealment`; envelope `deny` from `maskPaths()`; IPC spec.
- `src/context.ts` — `gitignored` → `concealment`.
- `src/phases/respond.ts` + `ipc.ts` — `conceal` spec over IPC; `conceals`
  predicate replaces `isGitignored`.
- `src/capability/index.ts` — `readMask: ctx.concealment.maskPaths()`.
- Tests: `concealment.test.ts`, `config.test.ts` (extend), `run.test.ts`
  (extend), a real-FS enumeration test.
- Docs: `docs/CONCEPTS.md` (hide/source/conceal/mask nouns); `CONTEXT.md`
  (security tiers — concealment is multi-source now; config surface);
  `AGENTS.md` (the gotcha note); `CHANGELOG.md`; `README.md` (the
  `hide`/`reveal` config + the `--hide`/`--reveal`/`--no-hide-*` flags).

## Migration (one step at a time, CI green between each)

1. `concealment.ts` + pure tests (`conceals`, `maskPaths`, the laws). CI green.
2. Config fields + merge/parse + extended monoid-law tests; CLI flags in
   `makeCommand`/`parseArgs` (`--hide`/`--reveal`/`--no-hide-secrets`/
   `--no-hide-gitignored` → `cli`). CI green.
3. setup.ts: build concealment, derive envelope `deny` from it,
   `ctx.concealment`; `policy.ts`/`buildEnvelope` takes explicit `deny`. CI
   green (gitignore source still the only populated one until config is set →
   behavior identical).
4. Thread to consumers: respond.ts (`conceal` spec + `conceals`),
   capability/index.ts (`maskPaths`). Retire `gitignored` naming. CI green.
5. Default-secrets source on + the two-source enumeration (git `ls-files` in
   repo mode; skip-list `Deno.readDir` walk outside). CI green.
6. Enforcement + respond-refusal integration tests. CI green.
7. Docs.

## Deferred

- **Mid-run file-glob masking** — the accepted gap (low-risk; dirs already
  covered).
- **Trailing-slash config dir-globs** (`hide: ["secrets/"]` masking a whole
  directory) — not implemented; config/secret globs match files, and gitignored
  _dirs_ are covered by the VCS source. Add a dir-glob → tmpfs path if a real
  config needs to hide a non-gitignored directory tree. (The default-secrets
  list is all file globs, so the security-by-default path is unaffected.)
- **Cage classification of a sandbox-exec read-throw** — pre-existing from the
  gitignore feature (a masked read throws on macOS → cage may fix-loop); flag
  for grill, not changed here. Default-on concealment (incl. outside repo mode +
  secret globs) widens the surface where this can trip; still its own slice.
- **Phase-input schema validation** — this design changes `ipc.ts` (`gitignored`
  → `conceal`), which is the trigger AGENTS.md names for adding `readInput()`
  schema validation. Kept separate: it's a cross-cutting pass over the whole
  `PhaseInput` (its own v1 backlog item), and `conceal` is plain data from the
  trusted orchestrator, not attacker-controlled.

[2026-05-29-gitignore-read-confinement-design.md]: ./2026-05-29-gitignore-read-confinement-design.md
