// effects: spawns deno subprocesses
/**
 * The runner — a SEPARATE process from the agent. Given an approved
 * script and the human-granted permission set, it runs the script via
 * `deno run --no-prompt <scoped flags>` so the Deno permission model
 * enforces the boundary. The agent cannot invoke this; only an approval
 * does. (Tier-2 OS isolation — bubblewrap/Landlock — will wrap this call
 * on supporting platforms later; v1 is the portable Deno-permission floor.)
 */

export interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
  /** The exact flags the runner used (for the pagu:result audit entry). */
  ranWith: string[];
  /**
   * Whether the output is safe to auto-return into the agent's context.
   * True iff the runner granted no network (so output can't have phoned
   * home); net-granted runs require a human glance first.
   */
  autoReturn: boolean;
}

/** `allow-read=./x` -> `--allow-read=./x` (idempotent on a leading `--`). */
function toFlag(p: string): string {
  return p.startsWith("--") ? p : `--${p}`;
}

/** Did the granted set include any network capability? */
function grantsNet(perms: string[]): boolean {
  return perms.some((p) => /^(--)?allow-(net|all)\b/.test(p));
}

export async function runScript(opts: {
  scriptPath: string;
  perms: string[];
  /** Working directory for the run (typically a disposable scratch dir). */
  cwd?: string;
}): Promise<RunResult> {
  const flags = opts.perms.map(toFlag);
  const ranWith = ["--no-prompt", ...flags];
  const command = new Deno.Command("deno", {
    args: ["run", ...ranWith, opts.scriptPath],
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const dec = new TextDecoder();
  return {
    exit: code,
    stdout: dec.decode(stdout),
    stderr: dec.decode(stderr),
    ranWith,
    autoReturn: !grantsNet(opts.perms),
  };
}
