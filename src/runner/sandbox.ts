// effects: sandbox detection (probes PATH); pure: command construction
/**
 * OS-level sandbox tier — defense-in-depth BENEATH Deno's permission model,
 * not a replacement. It wraps the runner's `deno run` so that even a
 * subprocess spawned via `--allow-run` (which Deno does NOT permission-bound)
 * is contained by the kernel: no network unless granted, and writes confined
 * to the granted paths + the run's scratch dir. Reads stay broad at the OS
 * layer — Deno still confines the script's own reads, and hardening the
 * write + network escape vectors is the high-value, robust part.
 *
 * Linux: bubblewrap (`bwrap`) when installed. macOS: `sandbox-exec`.
 * Elsewhere / when unavailable: "none" — the portable Deno-permission floor
 * still applies, so there is no regression.
 */
export type SandboxKind = "bwrap" | "sandbox-exec" | "none";

let cached: SandboxKind | undefined;

/** Detect the best available sandbox for this OS (memoized). */
export async function detectSandbox(): Promise<SandboxKind> {
  if (cached !== undefined) return cached;
  if (Deno.build.os === "darwin") return (cached = "sandbox-exec");
  if (Deno.build.os === "linux" && (await onPath("bwrap"))) {
    return (cached = "bwrap");
  }
  return (cached = "none");
}

async function onPath(bin: string): Promise<boolean> {
  try {
    const r = await new Deno.Command(bin, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return r.code === 0;
  } catch {
    return false;
  }
}

export interface SandboxScope {
  /** Absolute paths the run may write (resolved to existing mount points). */
  writableMounts: string[];
  /** Whether network was granted (else the sandbox denies it). */
  allowNet: boolean;
}

/**
 * Wrap a `deno run …` invocation in the given OS sandbox. Pure: returns the
 * command + args to spawn (the identity wrap for "none").
 */
export function wrapForSandbox(
  kind: SandboxKind,
  denoArgs: string[],
  scope: SandboxScope,
): { command: string; args: string[] } {
  if (kind === "bwrap") {
    return {
      command: "bwrap",
      args: [...bwrapArgs(scope), "deno", ...denoArgs],
    };
  }
  if (kind === "sandbox-exec") {
    return {
      command: "sandbox-exec",
      args: ["-p", sbplProfile(scope), "deno", ...denoArgs],
    };
  }
  return { command: "deno", args: denoArgs };
}

function bwrapArgs(scope: SandboxScope): string[] {
  // Read-only view of the whole host (deno + libs need it; reads stay
  // Deno-bound), fresh /dev + /proc, private /tmp; then re-expose the
  // writable mounts over it. Network namespace dropped unless granted.
  const args = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--die-with-parent",
  ];
  for (const m of dedupe(scope.writableMounts)) args.push("--bind-try", m, m);
  if (!scope.allowNet) args.push("--unshare-net");
  return args;
}

function sbplProfile(scope: SandboxScope): string {
  const writable = dedupe([
    ...scope.writableMounts,
    "/private/tmp",
    "/private/var/folders", // macOS per-user temp
  ]);
  const lines = [
    "(version 1)",
    "(allow default)", // reads/exec allowed; Deno still bounds the script
    "(deny file-write*)",
    ...writable.map((p) => `(allow file-write* (subpath ${q(p)}))`),
  ];
  if (!scope.allowNet) lines.push("(deny network*)");
  return lines.join("\n");
}

const q = (s: string) => JSON.stringify(s); // an SBPL string is double-quoted
const dedupe = (xs: string[]) => [...new Set(xs)];
