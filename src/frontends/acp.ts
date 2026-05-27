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
export function acpUI(conn: AcpConn, sessionId: string): UI {
  const chunk = (text: string): void => {
    void conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  };
  return {
    status: () => {},
    show: chunk,
    stream: chunk,
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

  async newSession(_p: NewSessionRequest): Promise<NewSessionResponse> {
    const id = newSessionId(new Date());
    await this.makeSession(id);
    return { sessionId: id };
  }

  async loadSession(p: LoadSessionRequest): Promise<LoadSessionResponse> {
    await this.makeSession(p.sessionId);
    return {};
  }

  async prompt(p: PromptRequest): Promise<PromptResponse> {
    const ctx = this.sessions.get(p.sessionId);
    if (!ctx) throw new Error(`session ${p.sessionId} not found`);
    const text = p.prompt
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    await runTask(ctx, text);
    return { stopReason: "end_turn" };
  }

  // v1: runTask isn't cancellable mid-loop. Accept the notification as a no-op
  // so the protocol stays well-formed; cooperative cancellation is deferred.
  cancel(_p: CancelNotification): Promise<void> {
    return Promise.resolve();
  }

  private async makeSession(id: string): Promise<void> {
    const ctx = await buildContext(
      { ...this.opts, session: id, cont: false },
      this.agents,
      acpUI(this.conn, id),
      acpApprover(this.conn, id),
    );
    this.sessions.set(id, ctx);
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
