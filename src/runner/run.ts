// effects: spawns deno subprocesses
import { dirname, join } from "@std/path";
import {
  type SandboxKind,
  type SandboxScope,
  wrapForSandbox,
} from "./sandbox.ts";

/**
 * The runner — a SEPARATE process from the agent. Given an approved
 * script and the human-granted permission set, it runs the script via
 * `deno run --no-prompt <scoped flags>` so the Deno permission model
 * enforces the boundary. The agent cannot invoke this; only an approval
 * does. When an OS sandbox is available it additionally wraps the run
 * (bubblewrap on Linux, sandbox-exec on macOS) — a second, kernel-level
 * wall beneath the Deno floor (see sandbox.ts).
 */

export interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
  /** The exact flags the runner used (for the pagu:result audit entry). */
  ranWith: string[];
  /** Which OS sandbox wrapped the run (or "none" — Deno floor only). */
  sandbox: SandboxKind;
}

/** Default wall-clock ceiling for a single run/cage (ms). Generous enough for
 * real work (installs, network), short enough that a true hang is bounded. */
export const RUN_TIMEOUT_MS = 120_000;

/** `allow-read=./x` -> `--allow-read=./x` (idempotent on a leading `--`). */
function toFlag(p: string): string {
  return p.startsWith("--") ? p : `--${p}`;
}

/** Did the granted set include any network capability? */
function grantsNet(perms: readonly string[]): boolean {
  return perms.some((p) => /^(--)?allow-(net|all)\b/.test(p));
}

export async function runScript(opts: {
  scriptPath: string;
  perms: readonly string[];
  /** Working directory for the run (typically a disposable scratch dir). */
  cwd?: string;
  /** OS sandbox to wrap the run in (default "none" — Deno floor only). */
  sandbox?: SandboxKind;
  /** Arguments forwarded to the script (e.g. from a skill invocation). */
  scriptArgs?: string[];
  /** Called with each stdout chunk as it arrives. When present, stdout is
   *  streamed incrementally; the full text is still returned in RunResult. */
  onStdout?: (chunk: string) => void;
  /** Gitignored paths (absolute) to hide from the sandbox view — read
   *  confinement. Canonicalized + classified here, then masked by the OS
   *  sandbox. Ignored at tier 1 ("none"). */
  readMask?: string[];
  /** Wall-clock ceiling (ms). On expiry the child is killed and the run reports
   *  a nonzero exit + a "timed out" stderr — so a wedged script (infinite loop,
   *  hung network read) can't pin the cage or a long-lived `pagu serve` forever.
   *  Defaults to {@link RUN_TIMEOUT_MS}. */
  timeoutMs?: number;
}): Promise<RunResult> {
  const flags = opts.perms.map(toFlag);
  const ranWith = ["--no-prompt", ...flags];
  const denoArgs = [
    "run",
    ...ranWith,
    opts.scriptPath,
    ...(opts.scriptArgs ?? []),
  ];
  const kind = opts.sandbox ?? "none";

  // The script + a throwaway DENO_DIR live in the scratch dir; the granted
  // write paths (resolved to existing mount points) are the other writables.
  const scratch = dirname(opts.scriptPath);
  const scope: SandboxScope = {
    writableMounts: resolveWritable(scratch, opts.perms),
    allowNet: grantsNet(opts.perms),
    readMask: classifyReadMask(opts.readMask ?? []),
  };
  const { command, args } = wrapForSandbox(kind, denoArgs, scope);
  // Under a sandbox the host DENO_DIR is read-only, so point it at scratch.
  const env = kind === "none"
    ? undefined
    : { DENO_DIR: join(scratch, ".deno") };

  // Always use spawn() so we can drain stdout/stderr concurrently (avoids
  // pipe-buffer deadlock) and optionally stream stdout chunks via onStdout.
  const child = new Deno.Command(command, {
    args,
    cwd: opts.cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let stdoutText = "";
  let stderrText = "";
  const drainStdout = async () => {
    for await (const c of child.stdout.pipeThrough(new TextDecoderStream())) {
      stdoutText += c;
      opts.onStdout?.(c);
    }
  };
  const drainStderr = async () => {
    for await (const c of child.stderr.pipeThrough(new TextDecoderStream())) {
      stderrText += c;
    }
  };
  // Wall-clock kill: a wedged script must not pin the cage / a long-lived serve.
  // SIGKILL the wrapper (bwrap/sandbox-exec die with it, reaping the child); the
  // drains then end as the pipes close. The result is surfaced as an error so
  // classifyRun treats it as a bug (not needs-perms) and it lands in the log.
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, timeoutMs);

  try {
    await Promise.all([drainStdout(), drainStderr()]);
    const { code } = await child.status;
    if (timedOut) {
      stderrText += `\npagu: run timed out after ${timeoutMs}ms (killed)`;
    }
    return {
      exit: timedOut ? 124 : code, // 124 = conventional timeout exit
      stdout: stdoutText,
      stderr: stderrText,
      ranWith,
      sandbox: kind,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve granted write perms to existing mount points: bind the target,
 * or its parent dir when the target file doesn't exist yet. */
function resolveWritable(scratch: string, perms: readonly string[]): string[] {
  const mounts = new Set<string>([scratch]);
  for (const p of perms) {
    const m = /^(?:--)?allow-write=(.+)$/.exec(p);
    if (!m) continue;
    let path = m[1];
    try {
      Deno.statSync(path);
    } catch {
      path = dirname(path); // create-target: make its parent writable
    }
    mounts.add(path);
  }
  return [...mounts];
}

/** Canonicalize (symlink-resolve) + classify (file vs dir) each masked path.
 * Canonicalization is load-bearing: the OS sandbox enforces against the real
 * path, and `resolve()` (used upstream) does not deref symlinks — without it a
 * deny rule silently misses (a leak, not an error). A path git lists but is
 * since deleted throws on realPathSync → skip it (nothing to hide). */
function classifyReadMask(paths: string[]): { path: string; isDir: boolean }[] {
  const out: { path: string; isDir: boolean }[] = [];
  for (const p of paths) {
    try {
      const real = Deno.realPathSync(p);
      out.push({ path: real, isDir: Deno.statSync(real).isDirectory });
    } catch {
      // path no longer exists — nothing to mask
    }
  }
  return out;
}
