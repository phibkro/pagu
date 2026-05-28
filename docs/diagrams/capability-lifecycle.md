# Capability lifecycle

How a single capability invocation travels from user input through the registry,
subprocess boundary, and sandboxed runner back to the conversation log.

**Key boundaries**

- The **respond phase** runs as a separate `deno` process with minimal
  permissions (`--allow-net=<model>`, `--allow-read=<allowlist>` only). It can
  talk to the model and read context; it cannot write files or run programs.
- The **runner** runs as a separate `deno` process inside the OS sandbox
  (bubblewrap on Linux, sandbox-exec on macOS) with exactly the approved
  permissions. Only the orchestrator triggers it — never the agent.
- The **process boundary** (JSON over stdin/stdout) is where typed log entries
  cross from the respond phase back to the orchestrator.

```mermaid
sequenceDiagram
    participant U  as User / Frontend
    participant O  as Orchestrator<br/>agent.ts
    participant R  as Respond phase<br/>respond.ts<br/><small>--allow-net=model<br/>--allow-read=allowlist</small>
    participant M  as Model API
    participant Ca as cap.execute<br/>capability pipeline
    participant Rn as Runner<br/><small>deno + bwrap/sandbox-exec<br/>approved perms only</small>

    U->>O: task string

    note over O: ctx.respond = () => spawnPhase(...)<br/>injected before turn loop

    O->>O: log.push({ kind:"message", role:"user" })
    O->>O: persist()

    loop ≤ MAX_TURNS

        O->>R: spawnPhase(phase input JSON)<br/>input: log, provider, capabilities data

        loop ≤ MAX_READS  [reads only]
            R->>M: chat(log, tools, onToken)
            M-->>R: tool_call: read
            R->>R: handleRead(path)
            R->>M: observation (tool result)
        end

        M-->>R: tool_call: write | invoke_skill | run_command | run_task
        R->>R: cap.toEntry(args, id) → typed Entry
        R-->>O: Entry[]  [JSON on stdout]

        note over O: isActionEntry(action)<br/>cap = actionCapabilities.find(c => c.entryKind === action.kind)

        O->>Ca: cap.execute(entry, ctx)

        note over Ca: pipeline([...gates, autoApprove/approve, run])<br/>cage → validate within ceiling → approve → run

        Ca->>Rn: runScript(body, perms, sandbox)
        note over Rn: Deno perms + OS sandbox<br/>no net unless granted

        Rn-->>Ca: RunResult { exit, stdout, stderr, ranWith }
        Ca->>Ca: net-output gate<br/>(if net granted → stop, no auto-return)
        Ca-->>O: "stop" | "loop"

        O->>O: log.push(result entry), persist()
        O->>U: show result

        alt outcome == "loop"
            note over O: continue to next turn
        else outcome == "stop"
            note over O: exit turn loop
        end

    end
```

**The net-output gate** (inside `performRun`, `src/capability/index.ts`) is
where output gating falls out of the runner's permissions: if the runner was
granted network access, the output might have exfiltrated data, so it does not
auto-return into the agent's context — the human sees a note and the loop stops.
Network-less runs auto-return safely.

**The respond phase permissions** are invariant #1: `respondFlags()` in
`agent.ts` is the sole place they are constructed, and `agent.test.ts` asserts
they never include write, run, env, or blanket allow.
