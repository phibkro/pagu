---
name: pagu
description: Use when an agent inside pagu needs one narrowly scoped read path, or when a trusted human host needs to review and resolve a pagu gate request.
---

# pagu access requests

Preserve the boundary: inhabitants may request access; only the trusted host
may resolve a request.

## Inside a pagu box

After an actual sandbox denial, use the available `request_read_access` tool.
Codex and Claude receive it through session-local MCP configuration; Pi receives
the same request core through a session-local native extension. Supply:

- `path`: the exact path that must become readable
- `need`: the concrete information or artifact needed
- `justification`: why the current task requires that exact path

The path must be one exact absolute, `$PWD`, `$HOME`, or `~` path. Do not use
wildcards, traversal, quotes, or control characters. Never request write
access, resolve a request, edit gate state, disable the sandbox, or alter
harness tool configuration.

Approval replaces the current box and resumes this harness session. The tool
call may therefore disconnect. After resume, retry the original read; do not
assume a grant from narration alone. If the host denies the request, continue
within the existing boundary.

If `request_read_access` is absent, report that the pagu integration is
unavailable. Programmatic clients may use the installed `fileRequest()` SDK as
a compatibility fallback, but should not ask the user to inject a prompt or
modify persistent harness configuration.

## On the trusted host

Read pending requests through `readPendingQueue()`. Resolve the exact pending ID
through `submitOperatorResolution()`, or use the thin human adapter:

```sh
PAGU_STATE="$XDG_RUNTIME_DIR/pagu/<session-id>" # or an absolute private mktemp dir
pagu resolve --state-dir "$PAGU_STATE" --request r1 --scope session
```

Use `--deny` or a scope of `once`, `session`, or `persist`. The operator
resolution file is host-only and must never be passed to `pagu-box` or mounted
inside a sandbox. Keep the state directory outside every policy `fs.rw` and
`fs.ro` root; gate startup rejects an exposed operator boundary.
