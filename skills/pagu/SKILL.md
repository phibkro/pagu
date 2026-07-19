---
name: pagu
description: Request narrowly scoped read access from inside pagu-box, or review and resolve pagu gate requests from the trusted host.
---

# pagu escalation

Use pagu's installed SDK as the authority on signatures. This skill teaches the
boundary; it does not duplicate policy logic.

## Inside a pagu box

Only file a request. Never attempt to resolve one or edit gate state.

```ts
import { fileRequest } from "@phibkro/pagu";

await fileRequest({
  need: "read the dependency's local source",
  justification: "compare the adapter with the exact installed API",
  suggested_rule: { "fs.ro": "/absolute/exact/path" },
});
```

The rule must be one exact read-only path: no wildcard, traversal, quote, or
control character. An approval causes the trusted gate to stop the current box
and resume the same harness session in a newly compiled box. Do not continue
work in the old process after requesting access.

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
