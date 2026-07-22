# Seccomp user-notif denial-observation spike

Status: bounded feasibility candidate; lead verification pending. This is not a
supported denial pipeline.

## Conditional verdict

`SECCOMP_RET_USER_NOTIF` is the preferred Linux candidate. The spike implements
the standard shape: a child sets `NO_NEW_PRIVS`, installs an `open`/`openat`
filter with `SECCOMP_FILTER_FLAG_NEW_LISTENER`, and passes the listener to its
parent. The parent is designed to read an absolute pathname from the stopped
child, deny the syscall with `EACCES`, and write one supervisor-side JSON line:

```json
{
  "syscall": "openat",
  "path": "/home/user/.ssh/id_ed25519",
  "verdict": "deny",
  "ts": "2026-07-22T10:11:12.345Z"
}
```

The separately packaged `pagu-denial-spike` wraps `pagu-box` to test only that
narrow interposition seam. It denies every match for its one exact path but
records only the first. The close-on-exec log remains supervisor-only. The
helper does not implement an event schema, telemetry collection, policy
derivation, automatic requests, or a general syscall mediation service.

The feasibility distinction is load-bearing:

- user-notif is **pre-syscall**. If the supervisor replies `CONTINUE`, it cannot
  observe whether bubblewrap's mount namespace later returned `ENOENT` or
  `EACCES`;
- the spike therefore denies one exact absolute path itself. That produces a
  real denied syscall and is the useful substrate for future block/ask, but a
  complete implementation must share or safely derive the compiled policy. It
  cannot claim to passively observe the existing mount denial;
- pathname inspection uses `process_vm_readv`. The notification ID is checked
  before responding, but another thread can still mutate the pointed-to bytes,
  cwd, dirfd, or filesystem between inspection and use. The exact-path proof
  deliberately avoids claiming complete path resolution.

## Mechanism trade-off

| Mechanism          | Trusted code and latency                                                                                                                                                  | TOCTOU                                                                                                                        | Coverage                                                                                                                                                        | Result                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| seccomp user-notif | Filter plus outside supervisor, fd handoff, remote-memory read, and at least two context switches per intercepted syscall.                                                | Path pointer, relative cwd/dirfd, symlinks, rename, and on-behalf operations all need deliberate handling.                    | Covers selected syscalls from dynamic, static, and raw-syscall callers; the filter must grow for `openat2`, stat/access families, and other capability classes. | Chosen: strongest common substrate with tier-3, but passive post-bubblewrap denial observation is not available from user-notif alone. |
| `LD_PRELOAD` shim  | Small dynamic-library shim; lower overhead and it can inspect the real libc call's return/`errno`. A trusted log still needs a protected fd/pipe to an outside collector. | Sees caller arguments and result, but path identity can still race. The sandboxed process can bypass or tamper with the shim. | Misses static binaries, direct syscalls, secure execution, alternate symbols/libcs, and mechanisms such as io_uring.                                            | Useful diagnostic fallback, not trustworthy or complete product evidence.                                                              |
| `SECCOMP_RET_LOG`  | Tiny filter, kernel audit path.                                                                                                                                           | Kernel records syscall-time metadata, but not a resolved policy path.                                                         | Selected syscalls only. Reading audit/kmsg is privileged and often host-global.                                                                                 | Disqualified for unprivileged pagu evidence.                                                                                           |

## Evidence and lead verification

The Nix derivation compiles the filter/supervisor with warnings-as-errors and
runs `denial-spike-test`. That unit check falsifies malformed JSON escaping,
non-exact path matching, and wrong syscall naming. It intentionally does not
claim that a real notification ran. Feasibility remains pending the lead's
outside-box command.

Run this from the repository **outside any pagu/Codex box**:

```sh
BOX="$(nix build .#pagu-box --no-link --print-out-paths)"
SPIKE="$(nix build .#pagu-denial-spike --no-link --print-out-paths)"
LOG="$(mktemp -t pagu-denial.XXXXXX.jsonl)"
DENIED="$HOME/.ssh/id_ed25519"
"$SPIKE/bin/pagu-denial-spike" \
  --log "$LOG" \
  --deny-path "$DENIED" \
  -- "$BOX/bin/pagu-box" --profile strict -- \
  "$SPIKE/bin/pagu-denial-spike" --probe "$DENIED"
test "$(wc -l < "$LOG")" -eq 1
grep -F '"syscall":"openat"' "$LOG"
grep -F "\"path\":\"$DENIED\"" "$LOG"
grep -F '"verdict":"deny"' "$LOG"
grep -Eq '"ts":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"}$' "$LOG"
cat "$LOG"
```

The falsifier is simple: a nonzero spike exit, a line count other than one, or a
record without the exact path/deny verdict means observability was not proven.

The nested worker run was attempted but is not evidence. Its outer seccomp
policy allowed listener installation and notification delivery, then denied
`process_vm_readv` with `EPERM`; the spike continued unmatched calls and failed
loud with `No data available`, producing no record.

## Cost to proceed

A real R1 denial-evidence pipeline needs more than this spike:

1. launch the observer outside bubblewrap and hand off the listener without
   exposing a general control socket;
2. derive classification from the exact compiled policy instead of maintaining a
   second allow/deny truth;
3. resolve absolute and relative paths, dirfds, cwd, symlinks, rename races, and
   on-behalf operations; expand and test the syscall set;
4. define a versioned denial event, bind it to session/profile/launch evidence,
   rate-limit/deduplicate it, and retain it outside sandbox-writable roots;
5. decide explicitly whether the supervisor becomes an enforcement point. If it
   only replies `CONTINUE`, another mechanism is required to learn the final
   kernel result.

Tier-3 can reuse the listener only after those foundations. A policy-classified
denial can stay blocked while the supervisor files a typed request, but the
current gate widens only by stopping and relaunching a complete box; it cannot
mutate the blocked namespace. Request, denial response, relaunch, and resume
therefore need one lifecycle rather than an in-place `CONTINUE` shortcut.

If the lead command succeeds, feasibility is **positive for unprivileged
interception and future block/ask**, but **not positive for a cheap passive
observer of today's bubblewrap denials**. Until then the implementation and unit
evidence support only that conditional conclusion. Proceeding to a full pipeline
is a deliberate security-boundary slice, not a small telemetry patch.
