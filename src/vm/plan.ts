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
  };
  return { argv, scope };
}
