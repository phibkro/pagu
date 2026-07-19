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
  command(session: string): readonly string[];
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

/** Verified against `codex-cli 0.144.4`: `codex resume SESSION_ID`. */
export function codexResumeAdapter(executable = "codex"): ResumeAdapter {
  return {
    harness: "codex",
    stateRw: ["$HOME/.codex"],
    command: (session) => [executable, "resume", session],
  };
}

/** Verified against `claude-code 2.x` (lead real-journey check 2026-07-20):
 * boxed `claude --resume SESSION_ID` resumes the exact session with context
 * intact, while boxed `claude --continue` reports "No conversation found to
 * continue" even under an rw-HOME profile — so UUID resume, not `--continue`,
 * is the reliable in-box form, and it is session-exact across relaunches. */
export function claudeResumeAdapter(executable = "claude"): ResumeAdapter {
  return {
    harness: "claude",
    stateRw: ["$HOME/.claude", "$HOME/.claude.json"],
    command: (session) => [executable, "--resume", session],
  };
}

export function resumeAdapter(harness: string): ResumeAdapter {
  if (harness === "codex") return codexResumeAdapter();
  if (harness === "claude") return claudeResumeAdapter();
  throw new ResumeAdapterNotVerifiedError(harness);
}
