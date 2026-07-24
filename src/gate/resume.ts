// pure: harness-specific resume command adapters.
import type { PolicyV0 } from "../policy/index.ts";

export class ResumeAdapterNotVerifiedError extends Error {
  override name = "ResumeAdapterNotVerifiedError";

  constructor(readonly harness: string) {
    super(`${harness} resume adapter has not been verified`);
  }
}

/** Port between grant application and a harness's stable resume syntax. */
export interface ResumeAdapter {
  readonly harness: string;
  /** Trusted host state mounted RW into this harness's otherwise isolated HOME. */
  readonly stateRw: readonly string[];
  /** Build a fresh command from a trusted nonce (Codex) or assigned UUID
   * (Claude). The fresh-session planner owns generation and attribution. */
  freshCommand(attribution: string): readonly string[];
  command(session: string): readonly string[];
}

export interface McpServerCommand {
  readonly command: string;
  readonly args?: readonly string[];
}

export function codexNonceMarker(nonce: string): string {
  return `<<<PAGU_SESSION_NONCE:${nonce}>>>`;
}

/** Compose harness-local authentication/session state over a standing policy.
 * Denies are retained unchanged and remain final during policy lowering. */
export function composeHarnessState(
  policy: PolicyV0,
  adapter: ResumeAdapter,
): PolicyV0 {
  return {
    ...policy,
    fs: {
      ...policy.fs,
      rw: [...new Set([...policy.fs.rw, ...adapter.stateRw])],
    },
  };
}

/** The outer pagu box is the enforced boundary, so the inner Codex sandbox and
 * approval gate stand down rather than double-gating the resumed session. */
export function codexResumeAdapter(
  executable = "codex",
  mcp?: McpServerCommand,
): ResumeAdapter {
  const mcpArgs = mcp
    ? [
      "-c",
      `mcp_servers.pagu.command=${JSON.stringify(mcp.command)}`,
      "-c",
      `mcp_servers.pagu.args=${JSON.stringify(mcp.args ?? [])}`,
      "-c",
      'mcp_servers.pagu.env_vars=["PAGU_REQUEST_SOCKET"]',
      "-c",
      'mcp_servers.pagu.enabled_tools=["request_read_access"]',
      "-c",
      "mcp_servers.pagu.required=true",
    ]
    : [];
  return {
    harness: "codex",
    stateRw: ["$HOME/.codex"],
    freshCommand: (nonce) => [
      executable,
      "-c",
      "approval_policy=never",
      "-c",
      "sandbox_mode=danger-full-access",
      ...mcpArgs,
      "pagu fresh-session attribution marker; no task is requested.\n\n" +
      codexNonceMarker(nonce),
    ],
    command: (session) => [
      executable,
      "resume",
      session,
      "-c",
      "approval_policy=never",
      "-c",
      "sandbox_mode=danger-full-access",
      ...mcpArgs,
    ],
  };
}

/** Verified against `claude-code 2.x` (lead real-journey check 2026-07-20):
 * boxed `claude --resume SESSION_ID` resumes the exact session with context
 * intact, while boxed `claude --continue` reports "No conversation found to
 * continue" even under an rw-HOME profile — so UUID resume, not `--continue`,
 * is the reliable in-box form, and it is session-exact across relaunches. */
export function claudeResumeAdapter(
  executable = "claude",
  mcp?: McpServerCommand,
): ResumeAdapter {
  const mcpArgs = mcp
    ? [
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          pagu: {
            type: "stdio",
            command: mcp.command,
            args: mcp.args ?? [],
            env: { PAGU_REQUEST_SOCKET: "/run/pagu/request.sock" },
          },
        },
      }),
    ]
    : [];
  return {
    harness: "claude",
    stateRw: ["$HOME/.claude", "$HOME/.claude.json"],
    freshCommand: (session) => [
      executable,
      ...mcpArgs,
      "--session-id",
      session,
    ],
    command: (session) => [executable, ...mcpArgs, "--resume", session],
  };
}

export function resumeAdapter(
  harness: string,
  executable?: string,
  mcp?: McpServerCommand,
): ResumeAdapter {
  if (harness === "codex") return codexResumeAdapter(executable, mcp);
  if (harness === "claude") return claudeResumeAdapter(executable, mcp);
  throw new ResumeAdapterNotVerifiedError(harness);
}
