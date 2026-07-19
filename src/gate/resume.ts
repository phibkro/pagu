// pure: harness-specific resume command adapters.

export class ResumeAdapterNotVerifiedError extends Error {
  override name = "ResumeAdapterNotVerifiedError";

  constructor(readonly harness: string) {
    super(`${harness} resume adapter has not been verified`);
  }
}

/** Port between grant application and a harness's stable resume syntax. */
export interface ResumeAdapter {
  readonly harness: string;
  command(session: string): readonly string[];
}

/** Verified against `codex-cli 0.144.4`: `codex resume SESSION_ID`. */
export function codexResumeAdapter(executable = "codex"): ResumeAdapter {
  return {
    harness: "codex",
    command: (session) => [executable, "resume", session],
  };
}

/** The seam is present, but live Claude resume behavior is deliberately not
 * claimed until its adapter has been exercised end-to-end. */
export function claudeResumeAdapter(): ResumeAdapter {
  return {
    harness: "claude",
    command() {
      throw new ResumeAdapterNotVerifiedError("claude");
    },
  };
}

export function resumeAdapter(harness: string): ResumeAdapter {
  if (harness === "codex") return codexResumeAdapter();
  if (harness === "claude") return claudeResumeAdapter();
  throw new ResumeAdapterNotVerifiedError(harness);
}
