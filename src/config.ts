// pure: mergeConfig/resolveProvider/configDir; effects: loadConfig, configDirFromEnv
/**
 * pagu config — intentionally minimal. Structured settings live in
 * `config.json`; the free-form "about my environment" prompt lives in
 * `environment.md` (markdown, so no JSON string-escaping). Both are
 * optional — zero-config defaults work with neither present.
 *
 * Location: `$XDG_CONFIG_HOME/pagu/` or `$HOME/.config/pagu/`.
 */
import { join } from "@std/path";

export interface PaguConfig {
  /** Provider preset name (see PRESETS) or "custom" with an explicit baseURL. */
  provider: string;
  model: string;
  /** Override the preset's API root (OpenAI Chat Completions, ends at /v1). */
  baseURL?: string;
  /** Name of the env var holding the API key (keeps secrets out of config). */
  apiKeyEnv?: string;
  /** Wire format override; presets set this (anthropic uses its own API). */
  format?: "openai" | "anthropic";
  allow: string[];
}

/**
 * A composable config layer — the unit roles compose into. Every field is
 * optional; the empty layer `{}` is the identity. Merge law (see
 * `docs/CONCEPTS.md`): scalars right-bias (last layer wins), list grants
 * (`allow`, `write`) set-union. A full `PaguConfig` is a layer with the
 * required fields filled in.
 */
export interface ConfigLayer {
  provider?: string;
  model?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  format?: "openai" | "anthropic";
  allow?: string[];
  write?: string[];
}

/** Provider presets. Most speak OpenAI Chat Completions; anthropic uses its
 * native Messages API (different wire format). */
export const PRESETS: Record<
  string,
  { baseURL: string; apiKeyEnv?: string; format?: "openai" | "anthropic" }
> = {
  ollama: { baseURL: "http://127.0.0.1:11434/v1" }, // local, no key
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  anthropic: {
    baseURL: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    format: "anthropic",
  },
};

export const DEFAULTS: PaguConfig = {
  provider: "ollama",
  model: "qwen3.5:9b",
  allow: [],
};

/** Resolve a config to its API root + key-env-var (preset, overridable).
 * Pure — the caller reads the actual secret from the env. */
export function resolveProvider(
  cfg: PaguConfig,
): { baseURL: string; apiKeyEnv?: string; format?: "openai" | "anthropic" } {
  const preset = PRESETS[cfg.provider] ?? {};
  const baseURL = cfg.baseURL ?? preset.baseURL;
  const apiKeyEnv = cfg.apiKeyEnv ?? preset.apiKeyEnv;
  const format = cfg.format ?? preset.format;
  if (!baseURL) {
    throw new Error(
      `unknown provider "${cfg.provider}" — use a preset ` +
        `(${Object.keys(PRESETS).join(", ")}) or set baseURL`,
    );
  }
  return { baseURL, apiKeyEnv, format };
}

export interface Loaded {
  config: PaguConfig;
  /** Merged agent instructions: AGENTS.md (the cross-tool standard) at
   * global then project scope, with a Claude Code CLAUDE.md fallback per
   * scope. "" if none. */
  agents: string;
}

async function readIfPresent(path: string): Promise<string> {
  try {
    return (await Deno.readTextFile(path)).trim();
  } catch {
    return "";
  }
}

/** First present (non-empty) file from a fallback list — AGENTS.md (the
 * cross-tool standard) preferred, CLAUDE.md as the Claude Code fallback. */
export async function firstPresent(...paths: string[]): Promise<string> {
  for (const p of paths) {
    const s = await readIfPresent(p);
    if (s) return s;
  }
  return "";
}

/** Merge a parsed config object onto a base, ignoring unknown/ill-typed
 * keys. Hand-rolled rather than a schema library — three fields don't
 * justify the dependency, and this keeps the trusted core small. */
export function mergeConfig(base: PaguConfig, parsed: unknown): PaguConfig {
  const out: PaguConfig = { ...base, allow: [...base.allow] };
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    if (typeof p.provider === "string") out.provider = p.provider;
    if (typeof p.model === "string") out.model = p.model;
    if (typeof p.baseURL === "string") out.baseURL = p.baseURL;
    if (typeof p.apiKeyEnv === "string") out.apiKeyEnv = p.apiKeyEnv;
    if (p.format === "openai" || p.format === "anthropic") {
      out.format = p.format;
    }
    if (Array.isArray(p.allow) && p.allow.every((x) => typeof x === "string")) {
      out.allow = p.allow as string[];
    }
  }
  return out;
}

/** Order-preserving union of optional string lists; `undefined` only when
 * both are absent (so `{}` stays the identity). Grants are a set — order and
 * repeats don't matter — but we keep first-seen order for readable output. */
function unionLists(a?: string[], b?: string[]): string[] | undefined {
  if (a === undefined && b === undefined) return undefined;
  const out: string[] = [];
  for (const x of [...(a ?? []), ...(b ?? [])]) {
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * Merge two config layers — the role-composition combinator. A **monoid**:
 * associative, with identity `{}`. Scalars take the right (later) layer when
 * it sets them (last-write-wins); list grants union. So composing roles
 * stacks scope and later roles win scalars — and because grants union as
 * sets, the resulting permission set doesn't depend on layer order.
 */
export function mergeLayer(a: ConfigLayer, b: ConfigLayer): ConfigLayer {
  const out: ConfigLayer = {};
  const provider = b.provider ?? a.provider;
  if (provider !== undefined) out.provider = provider;
  const model = b.model ?? a.model;
  if (model !== undefined) out.model = model;
  const baseURL = b.baseURL ?? a.baseURL;
  if (baseURL !== undefined) out.baseURL = baseURL;
  const apiKeyEnv = b.apiKeyEnv ?? a.apiKeyEnv;
  if (apiKeyEnv !== undefined) out.apiKeyEnv = apiKeyEnv;
  const format = b.format ?? a.format;
  if (format !== undefined) out.format = format;
  const allow = unionLists(a.allow, b.allow);
  if (allow !== undefined) out.allow = allow;
  const write = unionLists(a.write, b.write);
  if (write !== undefined) out.write = write;
  return out;
}

/** Fold layers left-to-right onto the identity — base first, roles in order. */
export function composeLayers(layers: ConfigLayer[]): ConfigLayer {
  return layers.reduce(mergeLayer, {});
}

/** Pure: compute the config dir from given env values. */
export function configDir(xdgConfigHome?: string, home?: string): string {
  if (xdgConfigHome) return join(xdgConfigHome, "pagu");
  return join(home ?? ".", ".config", "pagu");
}

/** Effect: read the config dir from the environment. */
export function configDirFromEnv(): string {
  return configDir(Deno.env.get("XDG_CONFIG_HOME"), Deno.env.get("HOME"));
}

export async function loadConfig(): Promise<Loaded> {
  const dir = configDirFromEnv();
  const cfgPath = join(dir, "config.json");
  let config = { ...DEFAULTS };

  let raw: string | null = null;
  try {
    raw = await Deno.readTextFile(cfgPath);
  } catch {
    // absent — use defaults
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // fail loud: a present-but-broken config is a mistake, not a default
      throw new Error(
        `invalid ${cfgPath}: ${e instanceof Error ? e.message : e}`,
      );
    }
    config = mergeConfig(config, parsed);
  }

  // Agent instructions: the cross-tool AGENTS.md standard (also read by
  // Codex, Cursor, …), with a Claude Code CLAUDE.md *fallback* per scope —
  // so Claude Code users need no duplication, but AGENTS.md wins when both
  // exist. Global scope first, then project, merged. Prose only: we never
  // read .claude/ settings (execution-model config that doesn't map here).
  const home = Deno.env.get("HOME") ?? ".";
  const parts = [
    await firstPresent(
      join(dir, "AGENTS.md"),
      join(home, ".claude", "CLAUDE.md"),
    ),
    await firstPresent("AGENTS.md", "CLAUDE.md"),
  ].filter((s) => s.length > 0);

  return { config, agents: parts.join("\n\n") };
}
