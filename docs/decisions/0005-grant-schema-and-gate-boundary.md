# ADR-0005: the grant schema and the box/gate boundary

- Status: Accepted (design; implementation follows the ADR-0004 merge)
- Date: 2026-07-19

## Context

ADR-0004 makes pagu = box (PEP: enforce, never decide) + gate (PA: decide,
never enforce). The hard-to-reverse decisions are (a) the shape of the policy
artifact both sides share, and (b) which side owns which behavior. Prior-art
constraints adopted from the analysis docs (pagu-box repo,
`docs/notes/composition-split-analysis.md` P1–P12): escalations must compile
into rules; enforcement must be fail-secure; empty policy means deny-all;
project-level policy from an untrusted repo may only narrow (ADR-0003's
analysis, generalized); approval is scoped and expiring, not a durable
widening by default.

## Decision

### 1. Two artifacts, one schema family

| Artifact | Lives | Written by | Trust |
| --- | --- | --- | --- |
| **policy** (standing) | `~/.config/pagu/policy.json` (user) · `.pagu/policy.json` (project, tracked) | operator / repo authors | user policy is authoritative; **project policy may only narrow it** — any widening key in a repo file is ignored with a loud warning (ADR-0003 rule, generalized) |
| **grant** (attempt-scoped) | derived at launch; recorded in the gate's log | the gate (compiled), or a parent grant (attenuated) | never hand-written; carries `parent` ref — the derivation chain is the audit trail and the revocation tree |

Schema v0 (JSON; versioned; unknown keys are an error — fail loud):

```jsonc
{
  "version": 0,
  "subject": { "agent": "claude", "label": "lang-bang worker" },
  "fs": {
    "home": "rw" | "tmpfs",          // profile axis 1
    "rw": ["$PWD"],                   // extra RW binds
    "ro": ["/srv/share/projects"],    // extra RO binds
    "deny": ["~/.ssh", "~/.gnupg"]    // deny always wins
  },
  "net": true,                        // v0: boolean; domains are a later axis
  "env": { "pass": ["ANTHROPIC_API_KEY"] },
  "escalation": {                     // what the gate may self-adjudicate
    "auto": [ { "fs.ro": "/srv/share/projects/**", "scope": "session" } ],
    "refuse": ["~/.ssh/**"]           // never even prompts
  },
  "parent": null,                     // grant-only: derivation ref
  "expires": null                     // grant-only: local timer, not revocation msg
}
```

Deny semantics: `deny` ⊃ built-in secret list; `refuse` ⊂ `deny`. The four
legacy profiles become named presets expressed *in* this schema (generated,
not parallel).

### 2. The boundary

| Behavior | box (PEP) | gate (PA) |
| --- | --- | --- |
| compile policy/grant → bwrap/seatbelt argv | ✓ (pure function; `--explain` prints it) | — |
| enforce; audit denials (structured log line per block) | ✓ | — |
| receive `pagu request`; queue; adjudicate (auto / refuse / escalate) | — | ✓ |
| operator surface (herdr notification, TTY fallback) | — | ✓ |
| persist decisions (session grants file; `persist` → user policy edit) | — | ✓ |
| relaunch box with widened grant + harness `--resume` | — | ✓ |
| evidence log (every request, decision, launch, revocation — event-sourced) | — | ✓ |

The request channel is a unix socket bind-mounted into the sandbox that
accepts **append-request only**; resolution requires the gate's end. The herdr
control socket is never mounted (agent-dispatch's rule, kept).

Box runs without gate (static, today's behavior + audit). Gate without flow is
the normal case; flow, when present, supplies/receives grants and evidence
above the gate.

### 3. Falsifiers (define done; written before code)

1. A widen request resolvable from inside the sandbox → design dead.
2. A denial that produces no audit record → R1 unmet.
3. A repo-local `.pagu/policy.json` that widens effective policy → trust rule
   broken.
4. A persisted grant that does not survive gate restart + box relaunch → P3
   (fail-secure) unmet.
5. `--explain` output ≠ actually-compiled argv → SSoT broken.

## Consequences

- The schema is public API from v0 (box, gate, homelab, later flow all
  consume it): versioned, with a floor test à la `src/mod.ts`.
- agent-dispatch's hardcoded strict-descent becomes a grant it *receives*;
  its monotone-narrowing check moves into grant attenuation (child fs/net ⊆
  parent), where it is schema-checkable rather than bash-encoded.
- The dispatcher's `--disable-userns` sed-patch is retired once the
  derivation record lives in the gate's log instead of PID-1 environ —
  restoring nested harness sandboxes for children (C5 resolution).
- v0 scope cuts, stated: no network domain granularity, no macaroon-style
  crypto (the `parent`/`expires` fields keep the discharge *shape* so a
  cryptographic realization is a later swap, not a redesign), no live mount
  widening (relaunch+resume only until the fd-passing spike earns its way in).

## Rejected alternatives

- **TOML policy files** — the surviving codebase (Deno, `config.json`,
  ADR-0003 folding) is JSON-native; two config syntaxes in one product is
  self-inflicted C1.
- **seccomp-notify interception in v0** — the agent already observes the
  denial (EACCES) and can articulate need + justification; a CLI request is
  20 lines where a syscall supervisor is a TCB. Revisit for non-cooperating
  binaries.
- **Widening grants stored repo-side** — a repo that carries its own
  widenings is ADR-0003's hostile-repo self-grant, restated.
- **Gate inside the box** — the adjudicator must be outside the boundary it
  adjudicates; anything else is self-approval.
