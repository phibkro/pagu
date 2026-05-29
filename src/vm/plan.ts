// pure: the launch plan for `pagu vm` — translate a host-side invocation into
// the in-guest pagu argv + the VMScope the launcher threads through the runtime.
import type { VMScope } from "./wrap.ts";

export interface VMLaunchOpts {
  /** The pagu task to run inside the guest. */
  task: string;
  /** Flags passed through to the in-guest pagu (e.g. `--repo`, `--model x`). */
  passthroughFlags: string[];
  /** Host dir pagu operates on — mounted into the guest (the blast radius). */
  cwd: string;
  /** The model host to allowlist for egress; `""` → fully offline. */
  modelHost: string;
  /** Image (variant) tag. */
  image: string;
  mode: "ephemeral" | "persistent";
  /** Guest mount point for `cwd` (default `/work`). */
  guestMount?: string;
  /** Concealed absolute HOST paths (from `buildConcealment(...).maskPaths()`,
   *  classified by `isDir`). Those under `cwd` become guest-path read-masks so
   *  the secret never enters the guest (tier-2's read-masking replacement);
   *  paths outside the mount are dropped (never threaded in anyway). */
  conceal?: { path: string; isDir: boolean }[];
}

export function planVMLaunch(
  o: VMLaunchOpts,
): { argv: string[]; scope: VMScope } {
  const guest = o.guestMount ?? "/work";
  const argv = ["pagu", o.task, ...o.passthroughFlags];
  const scope: VMScope = {
    mounts: [{ host: o.cwd, guest }],
    egress: o.modelHost ? [o.modelHost] : [],
    image: o.image,
    mode: o.mode,
    workdir: guest,
    readMask: toGuestReadMask(o.conceal ?? [], o.cwd, guest),
  };
  return { argv, scope };
}

/** Map concealed absolute host paths under `host` to guest-path masks under
 *  `guest`; drop anything outside the mount (not threaded in → no mask needed). */
function toGuestReadMask(
  conceal: { path: string; isDir: boolean }[],
  host: string,
  guest: string,
): { guestPath: string; isDir: boolean }[] {
  const prefix = host.endsWith("/") ? host.slice(0, -1) : host;
  return conceal.flatMap(({ path, isDir }) =>
    path === prefix || path.startsWith(`${prefix}/`)
      ? [{ guestPath: `${guest}${path.slice(prefix.length)}`, isDir }]
      : []
  );
}
