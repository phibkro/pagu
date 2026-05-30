// pure: sanitizeProjectLayer; effects: loadProjectConfig (fs read of .pagu/config.json)
/**
 * Per-project base config — `.pagu/config.json` (tracked/shared), auto-loaded
 * just by opening the repo. Folded AFTER global `config.json` and BEFORE the
 * opt-in bundles + flags (ADR-0003):
 *   defaults ⋄ global config.json ⋄ project config.json ⋄ profile/roles/skills ⋄ flags
 *
 * Invariant #3 (reads are untrusted): a `.pagu/config.json` arrives just by
 * being in the repo you opened, so it must not let a hostile repo self-grant
 * permissions, redirect egress, weaken concealment, or load orchestrator code.
 * `sanitizeProjectLayer` enforces this structurally, BEFORE the fold (ADR-0003).
 *
 * It's an **allowlist** (default-deny): without consented repo mode, only the
 * keys an untrusted repo touching them is *harmless* survive — _an untrusted
 * repo may pick the model name, cap tokens, and hide more; nothing else_.
 *   - `model`, `maxTokens`, `hide` (concealment-strengthening) — always apply.
 *   - Everything else — egress (`provider`/`baseURL`/`apiKeyEnv`/`format`),
 *     grants (`allow`/`write`/`allowedTasks`), advisor egress (`advisor*`), and
 *     concealment-*weakening* (`reveal`/`hideSecrets`/`hideGitignored`) — apply
 *     ONLY under consented repo mode.
 *   - `handlers` (orchestrator code paths) — NEVER, even under repo mode.
 * Default-deny by construction: a future `ConfigLayer` field is gated unless it
 * is added to `UNTRUSTED_SAFE`, so the security stance can't silently widen.
 */
import { join } from "@std/path";
import { type ConfigLayer, toLayer } from "./config.ts";

/** Keys an untrusted (non-repo-mode) project config may contribute: picking the
 * model, capping output tokens, and *adding* concealment are all harmless. */
const UNTRUSTED_SAFE: ReadonlyArray<keyof ConfigLayer> = [
  "model",
  "maxTokens",
  "hide",
];

/**
 * Strip the fields a project config may not safely contribute. Pure.
 *
 * Law (`untrusted ⇒ only UNTRUSTED_SAFE`): without `repoMode`, the returned
 * layer carries no key outside `UNTRUSTED_SAFE`; and it never carries `handlers`
 * in either mode. So a layer out of `sanitizeProjectLayer` cannot redirect
 * egress, widen the envelope, weaken concealment, or inject orchestrator code
 * outside consented repo mode — enforced by construction, not prose.
 */
export function sanitizeProjectLayer(
  layer: ConfigLayer,
  repoMode: boolean,
): ConfigLayer {
  const out: ConfigLayer = { ...layer };
  // handlers (code paths) are NEVER honored from a project config.
  delete out.handlers;
  // Outside consented repo mode, keep only the untrusted-safe allowlist.
  if (!repoMode) {
    for (const k of Object.keys(out) as Array<keyof ConfigLayer>) {
      if (!UNTRUSTED_SAFE.includes(k)) delete out[k];
    }
  }
  return out;
}

/**
 * Load `<projectBase>/.pagu/config.json` as a (raw, un-sanitized) ConfigLayer.
 * Absent → the identity layer `{}`. A present-but-broken file fails loud (a
 * malformed config is a mistake, not a default — mirrors `loadConfig`).
 *
 * Returns the raw layer; the caller MUST pass it through `sanitizeProjectLayer`
 * with the resolved repo-mode signal before folding it (the security boundary).
 */
export async function loadProjectConfig(
  projectBase: string,
): Promise<ConfigLayer> {
  const path = join(projectBase, ".pagu", "config.json");
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    return {}; // absent — the identity layer
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid ${path}: ${e instanceof Error ? e.message : e}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return toLayer(parsed as Record<string, unknown>);
}
