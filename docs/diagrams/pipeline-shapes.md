# Capability pipeline shapes

A string-diagram approximation of the four handler pipelines in pagu.

**Reading the diagram**

Each row is a `Step<C>` pipeline — Kleisli composition (`andThen`) of handlers
left-to-right. The carrier type (`Proposal` for write, `Exec` for the rest)
flows as a continuous wire through each box. A **gate** (yellow) may halt the
pipeline by returning `"done"` — dotted arrows show that exit path. The
**shared handlers** (blue) live in `src/capability/index.ts`; per-capability
gates live in their own modules.

```
Step<C> = C → Promise<"continue" | "done">
a → b   = andThen(a, b)   (Kleisli composition — short-circuit on "done")
[x]     = handler x       (box on the wire)
- - →   = "done" exit     (counit: wire is killed)
```

```mermaid
%%{init:{"theme":"base","themeVariables":{"fontSize":"14px","lineColor":"#475569"}}}%%
flowchart LR
    classDef shared   fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,font-weight:bold
    classDef gate     fill:#fef9c3,stroke:#92400e,color:#451a03
    classDef stop     fill:#fecaca,stroke:#b91c1c,color:#7f1d1d
    classDef cap_lbl  fill:none,stroke:none,color:#64748b,font-style:italic

    subgraph write["write  ·  Step&lt;Proposal&gt;"]
        direction LR
        wL(["Proposal"]):::cap_lbl
        wC["cage\nfix loop"]:::gate
        wA["approve\nhuman gate"]:::gate
        wR["run"]:::shared
        wL --> wC -->|continue| wA -->|continue| wR
        wC -. done .-> wX1(("✗")):::stop
        wA -. done: reject .-> wX2(("✗")):::stop
    end

    subgraph skill["invoke_skill  ·  Step&lt;Exec&gt;"]
        direction LR
        sL(["Exec"]):::cap_lbl
        sRB["resolveBody"]:::gate
        sCG["ceilingGate"]:::gate
        sAA["autoApprove"]:::shared
        sRN["run"]:::shared
        sL --> sRB -->|continue| sCG -->|continue| sAA -->|continue| sRN
        sRB -. done .-> sX1(("✗")):::stop
        sCG -. done .-> sX2(("✗")):::stop
    end

    subgraph cmd["run_command  ·  Step&lt;Exec&gt;"]
        direction LR
        cL(["Exec"]):::cap_lbl
        cGG["grammarGate"]:::gate
        cAA["autoApprove"]:::shared
        cRN["run"]:::shared
        cL --> cGG -->|continue| cAA -->|continue| cRN
        cGG -. done .-> cX1(("✗")):::stop
    end

    subgraph task["run_task  ·  Step&lt;Exec&gt;"]
        direction LR
        tL(["Exec"]):::cap_lbl
        tPG["policyGate"]:::gate
        tCG["taskCeilingGate"]:::gate
        tAA["autoApprove"]:::shared
        tRN["run"]:::shared
        tL --> tPG -->|continue| tCG -->|continue| tAA -->|continue| tRN
        tPG -. done .-> tX1(("✗")):::stop
        tCG -. done .-> tX2(("✗")):::stop
    end
```

**The shared suffix** (`autoApprove → run`, in blue) is the deduplication the
`src/capability/` module captures. All three auto-approved capabilities
(`invoke_skill`, `run_command`, `run_task`) end identically: log the approve
decision, then execute in the sandboxed runner with the net-output gate.

`write` shares only `run` (via `performRun`) — its `approve` is richer: it
shows the review aid, optionally calls the advisor, and asks the human.

**Gate law (gate-never-widen):** every gate may narrow or halt (`"done"`) but
may never widen the carrier's permission set. This is the permission lattice law
(composition holds-or-tightens) expressed as a type invariant.
