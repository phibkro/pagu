# ADR-0004: pagu pivots to sandbox + gate; the agent harness is archived

- Status: Accepted (operator decision 2026-07-19)
- Date: 2026-07-19

## Context

Three attempts at "powerful agents, safe by construction" now coexist, each
solving one plane of the problem (full analysis:
`/srv/share/projects/pagu-box/docs/notes/composition-split-analysis.md` and
`escalation-alignment-analysis.md`, committed 2026-07-19):

| Attempt          | Solved                                                                       | Fatal gap                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| pagu (this repo) | the whole loop — envelope auto-approve, human gate, pending queue, event log | coupled to its **own harness**, which loses to frontier harnesses (Claude Code, Codex) on raw capability; daily work never moved here |
| pagu-box         | OS enforcement around _any_ harness                                          | mechanism without authority: no policy surface, no audit, no escalation — operators bail to `bypassPermissions`                       |
| flow             | policy authority + evidence (control plane)                                  | deliberately holds no enforcement mechanism                                                                                           |

Session-transcript evidence shows the real-world result: the daily posture is
the un-sandboxed gamble, and permission friction manifests as **mode
capitulation**, not recorded denials. Prior-art synthesis (NIST 800-207,
SDN/Ethane, seL4/macaroons — see the composition analysis) names the missing
organ: a **Policy Administrator** — the component that compiles grants into
enforcement, hosts the escalation queue, and turns operator decisions into
persisted rules.

The operator's judgment, accepted here: a _dedicated safety harness_ was too
fine a point — the market's harnesses won the worker slot, and safety must wrap
them rather than replace them.

## Decision

**pagu becomes the product name for the sandbox + gate pair.** The
vertically-integrated agent harness is archived; its security organs are
repurposed as the gate's foundation.

1. **Consolidation.** pagu-box's sandbox launcher merges into this repo
   (history-preserving subtree merge). Target CLI shape:
   - `pagu box …` — the PEP: policy-file → bwrap/seatbelt compiler, denial
     audit, `--explain`. A `pagu-box` compatibility shim remains so
     `agent-dispatch` and homelab keep working until migrated.
   - `pagu gate` — the PA daemon: request queue (resolve-only), tiered
     adjudication, once/session/persist decisions, relaunch-with-`--resume`
     widening, decision/evidence log.
   - `pagu request` — the in-sandbox CLI that files a structured widen request
     `{need, justification, suggested_rule}`.
   - `pagu grants` / `pagu revoke` — standing-grant management (surviving UX
     from the harness's `/grants`, `/revoke`).
2. **Repurposed** (stay on main, become gate modules): `approval.ts` (Approver
   seam + deferring approver + pending-proposal protocol from `pagu serve`),
   `permissions/` (envelope + concealment model → grant schema seed),
   `capability/` (ceiling validation), `log/` + `events.ts` (event-sourced
   decision log), `runner/sandbox.ts` (bwrap/seatbelt detection — merges with
   pagu-box's compiler), `config/` (layered folding + **ADR-0003's
   untrusted-repo gating**, which becomes the narrow-only rule for project
   policy files — see ADR-0005).
3. **Archived** (deleted from main; preserved at tag `harness-final` and branch
   `archive/harness`): the model loop and phases (`phases/`, `agent.ts`,
   `loop.ts` + combinators), `providers/`, `read.ts`, `write/`, `observe.ts`,
   `skills/`, `tasks/`, cage self-test, TUI/ACP/serve harness frontends, `vm/`,
   eval + golden-scenario examples. The North-Star workflow-SDK is parked with
   them: flow owns lawful orchestration; two cores was one too many.
4. **pagu-box repo** is archived after the subtree merge lands and homelab
   points at this repo's flake output.
5. **Docs follow the pivot**: README/CONTEXT/ROADMAP rewritten around
   sandbox+gate; the invariants that survive re-stated against the new boundary
   (no-exec dies with the harness; **gate-never-widen, deny-wins,
   reads-are-untrusted, evidence-over-reports survive** — they were never
   harness-specific).

## Consequences

- One name, one repo, one policy language for the whole safety surface; the C1
  "five policy languages" and C2 "two competing stacks" conflicts from the
  composition analysis dissolve by construction.
- The hermit-crab name finally matches the architecture: the crab (any harness)
  borrows a hard shell (box) with a gated aperture (gate).
- The harness's tests/demo (golden scenario, containment proofs) leave main —
  the gate needs its own falsifier suite (ADR-0005 lists the first four).
- Git history remains the archive; nothing is lost, and `archive/harness` can be
  resurrected if the bastion niche (no-exec harness for irreversible ops) is
  ever wanted again.
- flow's ADR 0005 (grants compile to lowered OS controls) gains its intended
  lowering target under a stable name; flow remains optional above the gate.

## Rejected alternatives

- **Keep the harness as a high-trust bastion niche** — rejected by the operator
  as over-fine; the niche is served acceptably by frontier harnesses in
  plan/read-only modes inside a strict box, and maintaining a fourth surface
  costs more than the niche returns. Revisit only with a concrete
  irreversible-ops use case that a boxed harness demonstrably cannot serve.
- **Pure archive (no repurpose)** — wastes the working approver/envelope/
  event-log code that is precisely the gate's parts list, and with it the
  hard-won ADR-0003 trust analysis.
- **Two repos (pagu-gate separate from pagu-box)** — recreates the seam this
  pivot exists to close; the PA and PEP co-evolve (one schema, one test suite)
  and NIST's PE/PA/PEP seams are module boundaries, not repo boundaries.
- **Merging into flow instead** — flow's own constitution scopes it away from
  enforcement ("not replacing agent-dispatch security enforcement"); the gate
  must work standalone in a bare herdr session with no control plane running.

## Revisit conditions

Revisit if the subtree merge proves the Deno gate cannot cleanly drive the
nix/bash box (packaging friction), if flow grows an enforcement ambition, or if
a resurrection-worthy bastion use case appears.
