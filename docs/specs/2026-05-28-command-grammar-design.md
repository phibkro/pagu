# Command grammar — unified command policy + read-only-command gate (design)

> Status: **implemented 2026-05-28** (via tdd; example slices drove the
> recognizer's shape, property tests — fast-check — locked the invariants).
> Resolves backlog #3 (read-only-command auto-approve gate) and folds in part of
> #4 by **subsuming** `run_task`'s exact-enum policy into one command construct.
> `recognize` (`tasks/grammar.ts`) is the safe-sublanguage recognizer;
> `DEFAULT_RULES` (`tasks/defaults.ts`) the vetted rg/git rules; the
> `run_command` tool feeds the existing `command-invoke` →
> `executeCommandInvocation` spine, which runs default-rule matches read-only
> (no cage — the ceiling is declared). Live-verified against Ollama (rg search →
> auto-approved, exit 0). The unified tool interface settled as **two
> presentations over one spine**: `run_task` (exact enum) + `run_command`
> (structured free args), not a single tool — separate presentations, shared
> dispatch.

## Goal

Let the agent run **content-search / read-only commands** the `read` tool can't
express (`rg <pattern>`, `git log`, `git diff`) — auto-approved, with the search
arguments **agent-supplied but validated** by a formal grammar. Do it by
generalising the existing `run_task` command policy rather than adding a
parallel system: one **command construct**, of which today's exact-name task is
the degenerate (zero-free-arg) case.

## The framing — a regular sublanguage of safe argv invocations (LangSec)

Today's flag handling would be an informal, scattered parser — the classic
**weird machine** (crafted args drive a permitted program into an escalated
state, e.g. `rg --pre sh`). The LangSec fix: define a **formal grammar for the
valid (safe) invocations** and **fully recognise** input before acting —
default-deny, reject everything the grammar doesn't generate.

Two facts make this tractable and sound:

- **No shell.** We already run via `Deno.Command(program, {args:[…]})` — argv
  arrays, pre-tokenised, no shell. So we validate "one program's argv token
  sequence," not bash (which isn't even context-free). The no-shell architecture
  is what earns us regularity.
- **The safe sublanguage is regular.** Finite flag sets, bounded subcommand
  depth, bounded positional counts, value-binding — all bounded ⇒ regular ⇒ a
  decidable, fast **token-array state machine** (not a flat regex over a
  rejoined line, which would re-introduce tokenisation ambiguity; and no
  backtracking ⇒ no ReDoS).

Recognition (allowlist), **not** denylist: GNU-style prefix abbreviation
(`--pr`→`--pre`) and short-flag bundling (`-in`=`-i -n`) defeat denylists, but
an allowlist of canonical flags + reject-unknown rejects `--pr` automatically.
So default-deny is the only sound option here, not merely pagu's ethos.

## The unification — `run_task` is the degenerate grammar

| invocation kind         | grammar                                           | ceiling                  | approval        |
| ----------------------- | ------------------------------------------------- | ------------------------ | --------------- |
| project task (run_task) | **exact** (prefix = full args; no free args)      | cage-inferred (lockfile) | auto in ceiling |
| read-only command (new) | **free args** (allowed flags + typed positionals) | declared **read-only**   | auto in ceiling |

Both are one `CommandRule`; `recognize` generalises `matchesPolicy` (exact match
= the rule with no free slots). Auto-approve stays uniform: **recognised by a
rule ∧ cage-validated perms within the rule's ceiling ⇒ auto-approve**.

**The law that keeps free args safe — grammar-freedom ⇒ read-only ceiling.** A
rule with _any_ free args (flags or positionals) MUST carry a read-only ceiling
(`allow-read` only — no write, no net). A command that needs write/net stays
**exact-match** (run_task) or goes through the `write` tool's human gate. This
keeps the dangerous combination — agent-chosen args _and_ write/net — out of v1.
(The broader the arg-freedom, the tighter the ceiling.)

## The model (denotation)

```ts
// pure
interface CommandRule {
  program: string; // "rg", "git"
  prefix: string[]; // fixed subcommand tokens: ["log"] for `git log`; [] none
  flags: FlagSpec[]; // allowed canonical flags (allowlist)
  positionals: PositionalSpec;
  ceiling: string[]; // permission flags; read-only iff the rule has free args
  source: "default" | "explicit" | "inferred";
}
interface FlagSpec {
  name: string;
  value?: ValueType;
} // value undefined ⇒ boolean flag
type ValueType = "int" | "string" | "path" | { enum: string[] }; // "string" = opaque (e.g. a pattern)
interface PositionalSpec {
  slots: ValueType[];
  rest?: ValueType;
  min: number;
  max: number;
}
```

`string` positionals/values are **opaque-safe** (a search pattern is data; rg's
Rust regex is linear — no ReDoS). `path` positionals/values are
**containment-checked** against the read scope (resolve, must be under an
allowed root, no `..` escape; symlink-escape deferred — see Deferred). The split
"patterns are free, paths are contained" is the one type distinction the grammar
must encode.

### The recogniser (pure, total)

```ts
// pure: args (one token per element) + rule + readScope → ok | why-rejected
function recognize(
  rule: CommandRule,
  args: string[],
  readScope: string[],
): { ok: true } | { ok: false; reason: string };
```

State machine over the token array: consume `prefix` exactly; then per token —
`--flag` / `--flag=value` must name an allowlisted canonical flag (boolean ⇒ no
`=value`; value ⇒ validate type); a `-x` short flag must be exactly an
allowlisted canonical short flag (**no bundling**); `--` switches to
positionals; otherwise assign to the next positional slot/rest and validate its
type. Reject unknown flags, bundled/abbreviated flags, type mismatches, and
out-of-range positional counts. Finite states throughout.

## Design

### Where it lives — generalise `src/tasks/`

`tasks/` is already the command-policy home (coupling-based: `policy.ts`,
`discovery.ts`, `tool.ts` change together). Keep the folder; grow it:

- `tasks/policy.ts` — `CommandRule` (generalises `CommandEntry`); `recognize`
  generalises `matchesPolicy`. Lockfile logic stays for exact/inferred rules.
- `tasks/grammar.ts` (new, pure) — the `recognize` state machine + value-type
  validators + `path` containment (reuse `permissions/` `within`/`covers`).
- `tasks/defaults.ts` (new) — the vetted default rule set (below).
- `tasks/tool.ts` — the unified tool (below).
- `tasks/execute.ts` — generalise: free-arg read-only rules cage **per
  invocation** (args vary; no lockfile), confirm the run stays within the
  read-only ceiling, auto-approve, run. Exact rules keep today's lockfile path.

(Folder rename `tasks/`→`commands/` is deferred churn; the construct is still
"command policy / command grammar" per CONCEPTS.md.)

### Agent interface — structured `{program, args[]}`

The free-arg case can't be a single `enum` string, and a single string would
re-introduce a tokeniser (patterns with spaces break naive split). So the tool
takes **structured args** — one argv token per array element, sidestepping
tokenisation entirely (the LangSec-clean choice):

```
run_command({ program: <enum of allowed programs>, args: string[] })
```

The tool description advertises each rule's usage: the exact string for
degenerate rules; `program prefix [allowed flags] <positional shape>` for
free-arg rules. The orchestrator finds the rule by `program` + `prefix`, runs
`recognize`, and on success emits the existing `command-invoke` entry; the
orchestrator generates the `Deno.Command` body (agent never authors it — same as
today). (Tool name `run_command` is the honest superset of `run_task`; keeping
the `command-invoke` log kind.)

### Default rule set (v1, tiny + vetted)

- **`rg`** — the real win (content search the `read` tool can't do). Allow:
  `-i/--ignore-case`, `-n/--line-number`, `-C/-A/-B <int>`,
  `-t/--type <string>`, `-F/--fixed-strings`, `-m/--max-count <int>`;
  positionals: `pattern` (string), `paths` (path, repeatable, contained).
  **Exclude** the code-exec / escape flags: `--pre`, `--search-zip/-z`,
  `--hostname-bin`, `-f/--file`, `--pre-glob`.
- **`git log`**, **`git diff`** — read-only history/diff. Allow a small set
  (`--oneline`, `-n <int>`, `--stat`, `-p`, path positionals). **Exclude**
  `-c/-C` global config injection, `--output=`, pager/alias vectors.

Each ships read-only (`allow-read` + `allow-run=<program>`, no write, no net).

### Config surface

Defaults live in code (`tasks/defaults.ts`). Users extend via a structured
`commands` config key (folds through the `ConfigLayer` monoid by union, like
`allow` grants); `allowed-tasks` strings remain sugar for exact rules. A user
adding a rule **knowingly extends the TCB** — exactly like adding an
allowed-task; the set of rules is inspectable.

### Defense in depth — the recogniser is a filter, not the boundary

The grammar _reduces what is asked_ (fewer weird-machine inputs reach the
runner). What is _possible_ is still bounded by the permission floor (no
write/net), the OS sandbox (`bwrap`/`sandbox-exec` — unshares net, confines
writes, contains `--allow-run` children), and eventually backlog #5's
scoped-read namespace (which would neutralise even `--pre`-class read escalation
structurally). A grammar mistake therefore **degrades gracefully** rather than
breaching — invariant #2 (the runner's perms are the boundary) is unchanged.

## Testing

- **`recognize` by law** (pure, fake rules): accepts vetted invocations; rejects
  unknown flags, bundled (`-in`) and abbreviated (`--pr`) flags, boolean-flag
  `=value`, type mismatches, out-of-range positional counts; **path
  containment** rejects `..`/out-of-scope paths, accepts in-scope; **exact rule
  = today's `matchesPolicy`** behaviour preserved (degenerate grammar).
- **The read-only law**: a free-arg rule with a non-read-only ceiling is a
  config error (reject at load).
- **Executor** (real `deno`): a recognised `rg` search auto-approves, cages
  per-invocation, runs, returns output; a rule whose cage run discovers
  write/net is rejected (not auto-approved). `run_task`'s existing path stays
  green (lockfile, exact match).
- **Live-verify** in a repo: `rg` a term, confirm auto-approve + results;
  confirm `rg --pre …` is rejected by the grammar before any run.

## Success criteria

1. One `CommandRule` + `recognize` construct; `matchesPolicy`/run_task reuse it
   (exact = degenerate). No parallel command system.
2. Agent can run vetted read-only commands (`rg`, `git log/diff`) with validated
   free args, auto-approved within a read-only ceiling.
3. The grammar is default-deny, canonical-flags-only, with paths contained;
   exec-spawning flags excluded.
4. CLI/TUI/ACP unaffected (presentation is a separate problem — backlog #4);
   full `deno task ci` green; live-verified.

## Deferred

- **Write/net free-arg commands** (e.g. `prettier --write <path>`) —
  agent-chosen args + write is too dangerous for v1; use exact-match or the
  `write` tool.
- **Symlink escape** in `path` containment (resolve real path) — note, defer.
- **Per-tool grammar fidelity** (option B: model each tool's real parser) —
  rejected for v1; generic argv model + per-command constraint table (option A).
- **Folder rename** `tasks/`→`commands/`; **presentation generalisation**
  (backlog #4) — separate problem (CLI/TUI/ACP share dispatch, differ in
  presentation).

## Invariants preserved

- **#1** — the agent still only _names_ program + args; the orchestrator
  generates the body and the runner performs it. No new exec path; `run_command`
  rides the existing capability ladder.
- **#2** — the runner's Deno perms (+ sandbox) stay the boundary; `recognize` is
  a pure pre-filter.
- **#3** — read-only-command output is still untrusted input, but the read-only
  ceiling (no net) means no exfil path, and runs are visible in the log.
- **Deny-by-default** — `recognize` rejects anything the grammar doesn't
  generate; the rule set is the TCB.
