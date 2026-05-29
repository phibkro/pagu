// effects: VM-tier detection (probes PATH + the recursion-guard env).
import type { VMKind } from "./wrap.ts";

let cachedProbe: VMKind | undefined;

/**
 * Detect the best available VM tier for the launcher (sub-project B).
 *
 * The **recursion guard** is checked on every call (never cached): when
 * `PAGU_IN_VM` is set we are already running inside the guest, so we MUST
 * return `none` — otherwise a guest with a container runtime would wrap itself
 * forever. Only the runtime probe is memoized.
 *
 * `none` → run pagu directly on the host (exactly as today — no regression).
 */
export async function detectVM(): Promise<VMKind> {
  if (Deno.env.get("PAGU_IN_VM")) return "none"; // recursion guard — always live
  if (cachedProbe !== undefined) return cachedProbe;
  cachedProbe = (await onPath("podman")) ? "podman" : "none";
  return cachedProbe;
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
