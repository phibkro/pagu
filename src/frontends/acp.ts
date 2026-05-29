// effects: ACP agent frontend (JSON-RPC over stdio via @agentclientprotocol/sdk)
import {
  type Agent,
  AgentSideConnection,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  ndJsonStream,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { runTask } from "../agent.ts";
import type { AgentContext, Approver, ScriptEntry, UI } from "../context.ts";
import { buildContext, type RunOpts } from "../config/setup.ts";
import { newSessionId } from "../config/sessions.ts";
import type { Entry } from "../log/index.ts";
import { runCommand, type SlashCommand, slashCommands } from "../commands.ts";

/**
 * The `available_commands_update` notification advertising the shared slash
 * commands. Names are sent **bare** (no leading `/`) per the ACP convention
 * (`create_plan`); the editor renders the `/`. Pure — sent by newSession/loadSession.
 */
export function commandsUpdate(
  cmds: SlashCommand[],
  sessionId: string,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: cmds.map((c) => ({
        name: c.name.replace(/^\//, ""),
        description: c.description,
      })),
    },
  };
}

/**
 * Map one log entry to the `session/update` that surfaces it, or null to skip.
 * Stateless (the log links `result.script` → the action id), so it serves both
 * replay (map the whole log) and live (map produced entries). Messages become
 * message chunks; actions become tool calls; results update them.
 */
export function entryUpdate(
  e: Entry,
  sessionId: string,
): SessionNotification | null {
  const wrap = (
    update: SessionNotification["update"],
  ): SessionNotification => ({
    sessionId,
    update,
  });
  switch (e.kind) {
    case "message":
      return wrap({
        sessionUpdate: e.role === "user"
          ? "user_message_chunk"
          : "agent_message_chunk",
        content: { type: "text", text: e.text },
      });
    case "script":
      return wrap({
        sessionUpdate: "tool_call",
        toolCallId: e.id,
        title: `Run script ${e.id}`,
        kind: "execute",
        status: "in_progress",
      });
    case "skill-invoke":
      return wrap({
        sessionUpdate: "tool_call",
        toolCallId: e.id,
        title: `Skill: ${e.script}`,
        kind: "execute",
        status: "in_progress",
      });
    case "command-invoke":
      return wrap({
        sessionUpdate: "tool_call",
        toolCallId: e.id,
        title: `Task: ${e.program} ${e.args.join(" ")}`.trim(),
        kind: "execute",
        status: "in_progress",
      });
    case "result":
      return wrap({
        sessionUpdate: "tool_call_update",
        toolCallId: e.script,
        status: e.exit === 0 ? "completed" : "failed",
        content: [{
          type: "content",
          content: { type: "text", text: e.output },
        }],
      });
    default:
      return null; // decision / observation / perms — not surfaced
  }
}

// Replay: map the whole log through entryUpdate (messages + tool calls).
export function historyUpdates(
  log: Entry[],
  sessionId: string,
): SessionNotification[] {
  return log
    .map((e) => entryUpdate(e, sessionId))
    .filter((u): u is SessionNotification => u !== null);
}

/**
 * The minimal connection surface the UI/Approver adapters need.
 * `acp.AgentSideConnection` satisfies this structurally. Kept narrow so the
 * adapters are unit-testable with a fake connection.
 */
export interface AcpConn {
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>;
}

/**
 * pagu's UI port over an ACP connection. Model output (show/stream) becomes
 * `agent_message_chunk` notifications. `status` is transient orchestrator
 * progress — the editor shows its own activity indicator, so it's a no-op
 * (mapping it to chunks would spam the conversation).
 */
export function acpUI(conn: AcpConn, sessionId: string, flushMs = 50): UI {
  // content → agent_message_chunk (the answer); reasoning + activity markers →
  // agent_thought_chunk (kept out of the answer). The model's reasoning carries
  // no capability — it's a display affordance, like content tokens.
  const send = (
    text: string,
    kind: "agent_message_chunk" | "agent_thought_chunk",
  ): void => {
    void conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: kind, content: { type: "text", text } },
    });
  };
  // Coalesce streamed tokens per channel (~one notification per `flushMs`
  // window, bounded latency) instead of one per token. Per-channel so reasoning
  // and content never merge into a single chunk. (CLI/TUI stream per-token;
  // this batching lives only in the ACP adapter.)
  const bufs = { message: "", thought: "" };
  let timer: number | undefined;
  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (bufs.message) {
      send(bufs.message, "agent_message_chunk");
      bufs.message = "";
    }
    if (bufs.thought) {
      send(bufs.thought, "agent_thought_chunk");
      bufs.thought = "";
    }
  };
  return {
    status: () => {},
    // `show` is discrete output (results, review) — flush any pending stream
    // first so ordering is preserved, then send it immediately.
    show: (text: string) => {
      flush();
      send(text, "agent_message_chunk");
    },
    stream: (text: string, channel = "content") => {
      const key = channel === "content" ? "message" : "thought";
      bufs[key] += text;
      if (bufs[key].length >= 1024) flush();
      else if (timer === undefined) timer = setTimeout(flush, flushMs);
    },
    // Surface produced actions as tool calls. Messages are skipped — they
    // already stream live via `stream`. Sent directly (discrete, not coalesced).
    entries: (produced: Entry[]) => {
      for (const e of produced) {
        if (e.kind === "message") continue;
        const u = entryUpdate(e, sessionId);
        if (u) void conn.sessionUpdate(u);
      }
    },
  };
}

/**
 * pagu's Approver port over an ACP connection. The structured review aid has
 * already streamed via the UI (write/execute.ts calls ui.show(formatReview)
 * before approve); this surfaces the allow/reject buttons. Cancel = reject.
 */
export function acpApprover(conn: AcpConn, sessionId: string): Approver {
  return async (script: ScriptEntry, perms: string[]): Promise<boolean> => {
    const resp = await conn.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: script.id,
        title: `Run proposed script ${script.id}`,
        kind: "execute",
        status: "pending",
        rawInput: { perms },
      },
      options: [
        { kind: "allow_once", name: "Approve and run", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
    });
    if (resp.outcome.outcome === "cancelled") return false;
    return resp.outcome.optionId === "allow";
  };
}

/**
 * pagu as an ACP agent. The editor (client) drives it over JSON-RPC/stdio.
 * Each ACP session maps to a pagu conversation (same id), with its own
 * AgentContext built lazily. `session/prompt` runs the full pagu loop via
 * runTask; the runner stays the only execution path — pagu never uses the
 * client's terminal/fs capabilities for effects (invariant #1).
 */
export class PaguAgent implements Agent {
  private sessions = new Map<string, AgentContext>();
  /** One AbortController per in-flight session/prompt — cleared when done. */
  private controllers = new Map<string, AbortController>();

  constructor(
    private conn: AgentSideConnection,
    private opts: RunOpts,
    private agents: string,
  ) {}

  initialize(_p: InitializeRequest): Promise<InitializeResponse> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: "pagu", version: "0.1.0" },
      authMethods: [],
    });
  }

  // pagu needs no auth — the model API key lives in the agent's env, never
  // the client's concern. Return empty (the client proceeds straight to newSession).
  authenticate(): Promise<void> {
    return Promise.resolve();
  }

  async newSession(p: NewSessionRequest): Promise<NewSessionResponse> {
    const id = newSessionId(new Date());
    await this.makeSession(id, p.cwd);
    await this.conn.sessionUpdate(commandsUpdate(slashCommands, id));
    return { sessionId: id };
  }

  async loadSession(p: LoadSessionRequest): Promise<LoadSessionResponse> {
    const ctx = await this.makeSession(p.sessionId, p.cwd);
    // Replay the loaded conversation so the reopened thread isn't empty. Sent
    // directly + awaited (message-granular, ordered) — not through the streaming
    // coalescer.
    for (const u of historyUpdates(ctx.log, p.sessionId)) {
      await this.conn.sessionUpdate(u);
    }
    await this.conn.sessionUpdate(commandsUpdate(slashCommands, p.sessionId));
    return {};
  }

  async prompt(p: PromptRequest): Promise<PromptResponse> {
    const ctx = this.sessions.get(p.sessionId);
    if (!ctx) throw new Error(`session ${p.sessionId} not found`);
    const text = p.prompt
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    // A slash command (exact name match) is handled here; anything else —
    // including a prompt that merely begins with "/" — falls through to runTask.
    if (await runCommand(slashCommands, text, ctx)) {
      return { stopReason: "end_turn" };
    }
    const controller = new AbortController();
    this.controllers.set(p.sessionId, controller);
    try {
      await runTask(ctx, text, controller.signal);
    } finally {
      this.controllers.delete(p.sessionId);
    }
    return { stopReason: "end_turn" };
  }

  cancel(p: CancelNotification): Promise<void> {
    this.controllers.get(p.sessionId)?.abort();
    return Promise.resolve();
  }

  // `cwd` is the client's workspace root from session/new|load — the directory
  // pagu detects the repo + read-allowlist against (the agent subprocess's own
  // cwd is whatever the editor launched it from, not the project).
  private async makeSession(id: string, cwd?: string): Promise<AgentContext> {
    const ctx = await buildContext(
      { ...this.opts, session: id, cont: false, cwd },
      this.agents,
      acpUI(this.conn, id),
      acpApprover(this.conn, id),
    );
    this.sessions.set(id, ctx);
    return ctx;
  }
}

/**
 * Entry point for `pagu --acp`. Wires pagu as an ACP agent over stdio
 * (ndJSON) and runs until the client closes the connection.
 */
export async function acpMain(opts: RunOpts, agents: string): Promise<void> {
  // ndJsonStream(writable, readable): stdout carries our messages, stdin
  // carries the client's. Deno's native web streams need no node:stream bridge.
  const stream = ndJsonStream(Deno.stdout.writable, Deno.stdin.readable);
  const conn = new AgentSideConnection(
    (c) => new PaguAgent(c, opts, agents),
    stream,
  );
  await conn.closed; // block until stdin EOF — keeps the process alive
}
