// pure: command construction for the VM launcher tier (sub-project B).
/**
 * The coarse OUTER isolation tier — a host-side launcher that re-execs the whole
 * pagu process inside a reproducible guest (additive, beneath nothing: it wraps
 * pagu itself, not a child of it — the opposite direction from `wrapForSandbox`,
 * which wraps the runner's `deno run` child). Tiers 1–2 inside the guest are
 * unchanged; this is defense in depth at the machine boundary.
 *
 * `none` → the identity wrap (run pagu directly on the host — no regression).
 */
export type VMKind = "podman" | "none";

export interface VMMount {
  host: string;
  guest: string;
}

export interface VMScope {
  /** Host→guest dir pairs — the ONLY filesystem the guest sees (blast radius). */
  mounts: VMMount[];
  /** Allowlisted egress destinations (the model host by default). `[]` → fully
   *  offline (`--network none`); only the bundled-offline mode uses `[]`.
   *  NB: per-host egress confinement for a non-empty list is enforced by the
   *  launcher's network mechanism (firewall/proxy), not by a podman flag — see
   *  the B spec "To verify at TDD time". */
  egress: string[];
  /** The image (variant) tag to run. */
  image: string;
  mode: "ephemeral" | "persistent";
  /** Guest cwd for the pagu entrypoint (the mount point it operates on). */
  workdir?: string;
  /** Concealed GUEST paths to mask from the guest's view — tier-2's read-masking
   *  replacement (bwrap can't nest in a rootless container). A file → `/dev/null`
   *  bound over it (read returns EOF); a dir → an empty tmpfs overlay. The
   *  secret never enters the guest. Masks overlay the volume mounts, so they
   *  come AFTER them. */
  readMask?: { guestPath: string; isDir: boolean }[];
}

/**
 * Wrap a pagu invocation `argv` (`[command, ...args]`) in the given VM tier.
 * Pure: returns the command + args to spawn (the identity wrap for "none").
 */
export function wrapForVM(
  kind: VMKind,
  argv: string[],
  scope: VMScope,
): { command: string; args: string[] } {
  if (kind === "podman") {
    const args = ["run"];
    if (scope.mode === "ephemeral") args.push("--rm");
    args.push("--env", "PAGU_IN_VM=1"); // recursion guard (see detect.ts)
    if (scope.workdir) args.push("--workdir", scope.workdir);
    for (const m of scope.mounts) args.push("--volume", `${m.host}:${m.guest}`);
    // Masks LAST so they overlay the rw volume: a dir → empty tmpfs, a file →
    // /dev/null bound read-only (read returns EOF → empty). Mirrors bwrap's
    // readMask, applied at the mount layer (tier-2 can't nest in-guest).
    for (const m of scope.readMask ?? []) {
      if (m.isDir) args.push("--tmpfs", m.guestPath);
      else args.push("--volume", `/dev/null:${m.guestPath}:ro`);
    }
    if (scope.egress.length === 0) args.push("--network", "none");
    args.push(scope.image, ...argv);
    return { command: "podman", args };
  }
  return { command: argv[0], args: argv.slice(1) };
}
