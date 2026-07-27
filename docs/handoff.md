# Pagu product-lead handoff (edge-doc)

Ephemeral role-continuity doc for a FRESH session inheriting the pagu
product-lead role after context rot. Full detailed history lives in durable
memory:
`~/.claude/projects/-srv-share-projects-pagu/memory/pagu-product-lead.md` — read
it. This is the compact edge.

_Written 2026-07-22 at a clean gate-wait point._

## Your role & governance

You are **pagu product lead / advisor under OWNER-LED governance**. The operator
(Philip) directs the roadmap; you advise (own _correctness_) and execute slices
**on the operator's explicit request** — do NOT self-start roadmap work. A
"manager" monitors status/blockers/handoffs only and does not direct pagu
roadmap without an explicit operator request. The **web-relay** is a separate
adjacent lane, currently **PAUSED** — not pagu's concern.

## Where we are

pagu pivoted to **box (PEP) + gate (PA)**; the integrated harness is archived
(ADR-0004/0005). The thesis is **built** — every piece exists:

- Slices 1–9: box, gate (escalation loop closed), category profiles, verified
  gate-owned conversion recipe, harness inference. Tip work pushed.
- Slice 10: homelab flake-input migration LANDED (`98508f9` on homelab
  origin/main). **`github:phibkro/pagu` is now PUBLIC.**
- Slice 11 spike (`991429d`): seccomp user-notif denial capture **proven**
  (lead-verified). Design SoT: `box/docs/notes/seccomp-user-notif-spike.md`.
- Slice 12 (`d694282`, **current main tip**, pushed): opt-in
  `--observe-denials`, deny-list-driven from compiled `fs.deny` (SSoT),
  versioned profile-bound denial events, off-by-default. Lead-verified.

## Current edge (do THIS)

**Gate Slice 13 when the engineer's fresh boxed+gated launch lands, then
report.** Slice 13 = fresh (not resume-only) boxed+gated agent launch + race-
safe session discovery (diff pre/post session set) so relaunch-on-widen still
resumes the discovered id with context. It is the pagu unblock for
**fleet-deployment** (Herdr-launch-through-box, retiring the auto-approver's
detect-and-deny weakness). Brief: `SLICE-13-BRIEF.md` (untracked, repo root).

**Status right now:** engineer is WORKING on Slice 13 — uncommitted WIP in the
tree (`src/gate/resume.ts` gains `freshCommand()`, gate-session evidence v2 with
`initial:"fresh"|"resume"`, `src/gate/relaunch.ts` discovery, tests). NOT yet
committed. Do not touch its WIP.

## Next action

1. Poll the engineer (`herdr pane get wA:p2` — it is a HERDR PANE, not a
   subagent; NO auto-notify, poll on demand). When it reports Slice 13 done:
2. Gate it: `deno task ci`, `nix build .#pagu .#pagu-box`, verify trailer +
   `docs/decisions` untouched, then run the **lead-verify** yourself (fresh
   codex boxed+gated → new id discovered by diff → drive a widen → confirm
   relaunch resumes that id with context). The engineer CANNOT run real
   seccomp/box journeys (it's nested) — that's your job, outside a box.
3. Push (`git push origin main`), then **hand the operator the exact Herdr
   default-launch wiring** needed to complete fleet-deployment (the Herdr/
   homelab layer is operator-owned; Herdr is upstream Rust → a launch-wrapper
   config, not source).

## Operator constraints (in force)

- **No PRs; merge locally into main; the gate = verified intended behavior, NOT
  a review step.**
- **Commit email MUST be `71797726+phibkro@users.noreply.github.com`** — the
  gmail address trips GitHub GH007 push protection.
- Engineer commit trailer MUST be `Co-Authored-By: GPT 5.6 Sol via Codex` (it
  once mis-attributed to a Claude model — check before push).
- `docs/decisions/` = lead's pen; `src/` = engineer's. Commit by pathspec on the
  shared tree, never a bare `git commit` (sweeps the engineer's WIP).
- Briefs go as `SLICE-N-BRIEF.md` FILES in repo root (long pane-run text gets
  swallowed by the codex TUI on startup).

## Gotchas

- **Homelab is NOT rebuilt** — Slice 10 is pushed but not deployed. Do NOT
  depend on the new flake input in any work; build fresh pagu binaries
  (`nix build .#pagu .#pagu-box --no-link --print-out-paths`) and use those
  store paths, never the system `agent-dispatch`/`pagu-box`.
- The engineer runs gate-owned inside its OWN worker box → real seccomp/box/
  auth journeys fail nested → engineer unit-tests + hands you the lead-verify
  command; you run the real journey. Same honest seam every slice.
- **`validate` profile is PARKED** on local branch `slice-validate` (web-relay
  paused). It has a known gap: outside-`$PWD` writes succeed ephemerally (box
  creates writable intermediate bind dirs) — no host persistence, but not the
  strict `nonzero` the relay wanted. Resume only if web-relay unpauses.
- Piped exit codes lie (`cmd | head` returns head's status) — verify box exit
  codes unpiped.
- Fleet conversions are HELD: convert live sessions only on an explicit
  per-session operator go-signal; "idle"/"done" ≠ safe to recycle (a session can
  be `done` with a directive queued).

## WIP / refs

- main = `d694282` (pushed, in sync). Engineer WIP = uncommitted Slice 13.
- Parked: branch `slice-validate` (validate profile).
- Untracked in repo root: `SLICE-7/8/11/12/13-BRIEF.md` (historical, leave).
