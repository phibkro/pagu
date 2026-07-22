# Seccomp user-notif denial evidence

Status: the substrate proof is lead-verified. The compiled-deny observer is a
bounded, opt-in Linux capability pending its outside-box integration run.

## Verdict and integration shape

`SECCOMP_RET_USER_NOTIF` is the selected Linux substrate. An unprivileged child
sets `NO_NEW_PRIVS`, installs an `open`/`openat` filter with
`SECCOMP_FILTER_FLAG_NEW_LISTENER`, and passes the listener to its parent. The
outside parent reads an absolute pathname from the stopped child, classifies
it, returns `EACCES` for a deny, and appends supervisor-owned evidence.

The lead verified the original one-path capture outside a box. The promoted
integration keeps the fork/fd handoff in the small C program and makes the
existing TypeScript policy adapter select it as a wrapper around bubblewrap.
Without `--observe-denials`, the adapter still spawns bubblewrap directly: no
filter, supervisor, interception context switches, or C launch-path TCB.

The policy compiler returns `denialRules` beside the bubblewrap argv. Both come
from one expanded `fs.deny` array and one `pathKind` decision: existing files
match exactly, while directory and missing-path tmpfs masks cover the root and
descendants. The adapter passes those rules directly to the supervisor. There
is no second config file or hardcoded product deny list.
Observation fails before launch if a compiled deny rule contains `.`, `..`,
repeated separators, or a trailing separator, preventing enforcement/evidence
divergence without changing the default compiler path.

The supervisor appends each classified denial as strict JSONL. Version 1 is:

```json
{
  "version": 1,
  "syscall": "openat",
  "path": "/home/user/.ssh/id_ed25519",
  "verdict": "deny",
  "ts": "2026-07-22T10:11:12.345Z",
  "profile": "worker"
}
```

`profile` is optional and is present for named category launches. Session is
not available to a direct `pagu-box` invocation, so this slice does not invent
one. The adapter canonicalizes the log (or its existing parent) and rejects it
below any read-write root in the compiled launch. The supervisor opens it
append-only and close-on-exec, requires an owned private regular inode with one
link, creates it mode 0600, and refuses a final symlink.

## Load-bearing limits

- user-notif is **pre-syscall**. If the supervisor replies `CONTINUE`, it cannot
  observe whether bubblewrap's mount namespace later returned `ENOENT` or
  `EACCES`;
- the observer therefore denies a compiled absolute path itself. A complete
  implementation cannot claim to passively observe every existing mount
  denial;
- pathname inspection uses `process_vm_readv`. The notification ID is checked
  before responding, but another thread can mutate the bytes, cwd, dirfd, or
  filesystem between inspection and use;
- only lexically canonical absolute `open`/`openat` arguments are classified.
  Relative paths, non-UTF-8 byte paths, and ambiguous `.`, `..`,
  repeated-separator, or trailing-slash spellings can evade evidence, although
  bubblewrap enforcement still holds;

## Mechanism trade-off

| Mechanism | TCB and latency | TOCTOU | Coverage | Result |
| --- | --- | --- | --- | --- |
| seccomp user-notif | Filter, outside supervisor, fd handoff, remote-memory read, and at least two context switches per intercepted syscall. | Path pointer, relative cwd/dirfd, symlinks, rename, and on-behalf operations need deliberate handling. | Selected syscalls from dynamic, static, and raw-syscall callers. | Chosen: strongest common substrate with tier-3; opt-in due cost and TCB. |
| `LD_PRELOAD` shim | Smaller shim and lower overhead; can inspect libc return/`errno`. A trusted log still needs an outside collector. | Caller arguments and results still race; sandboxed code can bypass or tamper with the shim. | Misses static binaries, direct syscalls, secure execution, alternate libcs, and io_uring. | Diagnostic fallback only. |
| `SECCOMP_RET_LOG` | Tiny filter and kernel audit path. | Does not resolve a policy path. | Audit/kmsg collection is privileged and often host-global. | Disqualified for unprivileged pagu evidence. |

## Evidence and lead verification

The Nix derivation compiles the supervisor with warnings-as-errors and runs
`denial-spike-test`. Its unit checks cover v1 JSON escaping, syscall naming,
directory-subtree versus file-exact matching, ambiguous-path false positives,
hardlink log aliases, and non-denied false positives.
TypeScript tests bind observer rules to `CompiledPolicy.fs.deny`, reject
unknown/malformed v1 records, reject a log below writable `$PWD`, and prove the
default adapter still invokes bubblewrap directly.

Run this from the repository **outside any pagu/Codex box**:

```sh
BOX="$(nix build .#pagu-box --no-link --print-out-paths)"
SPIKE="$(nix build .#pagu-denial-spike --no-link --print-out-paths)"
DENIED_LOG="$(mktemp -t pagu-denied.XXXXXX.jsonl)"
ALLOWED_LOG="$(mktemp -t pagu-allowed.XXXXXX.jsonl)"
DENIED="$HOME/.ssh/id_ed25519"
ALLOWED="/etc/hosts"
"$BOX/bin/pagu-box" --profile worker --observe-denials "$DENIED_LOG" -- \
  "$SPIKE/bin/pagu-denial-observer" --probe "$DENIED"
test "$(wc -l < "$DENIED_LOG")" -eq 1
grep -F '"version":1' "$DENIED_LOG"
grep -F '"syscall":"openat"' "$DENIED_LOG"
grep -F "\"path\":\"$DENIED\"" "$DENIED_LOG"
grep -F '"verdict":"deny"' "$DENIED_LOG"
grep -F '"profile":"worker"' "$DENIED_LOG"
grep -Eq '"ts":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"' "$DENIED_LOG"
"$BOX/bin/pagu-box" --profile worker --observe-denials "$ALLOWED_LOG" -- \
  "$SPIKE/bin/pagu-denial-observer" --probe-allowed "$ALLOWED"
test ! -s "$ALLOWED_LOG"
cat "$DENIED_LOG"
```

The integration is not verified if the denied run is nonzero or lacks exactly
one valid record, if the allowed run emits anything, or if the record lacks the
compiled deny path, v1, deny verdict, timestamp, or profile context.

The nested worker run remains non-evidence: the outer policy denies
`process_vm_readv` with `EPERM` after notification delivery.

## Explicit deferrals

A complete denial-evidence pipeline still needs:

1. classification of all policy denials rather than only explicit `fs.deny`;
2. relative paths, dirfds, cwd, symlinks, rename races, on-behalf operations,
   `openat2`, stat/access families, and io_uring;
3. gate-owned session/launch binding plus deliberate rate limits,
   deduplication, retention, and telemetry ingestion;
4. a separate tier-3 design deciding whether the supervisor blocks and files a
   request before the gate stops, recompiles, relaunches, and resumes the box.

These are security-boundary slices, not extensions hidden inside this bounded
observer.
