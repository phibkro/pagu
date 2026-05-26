/**
 * pagu config — intentionally minimal. Structured settings live in
 * `config.json`; the free-form "about my environment" prompt lives in
 * `environment.md` (markdown, so no JSON string-escaping). Both are
 * optional — zero-config defaults work with neither present.
 *
 * Location: `$XDG_CONFIG_HOME/pagu/` or `$HOME/.config/pagu/`.
 */
export interface PaguConfig {
  model: string;
  ollama: string;
  allow: string[];
}

export const DEFAULTS: PaguConfig = {
  model: "qwen3.5:9b",
  ollama: "http://127.0.0.1:11434",
  allow: [],
};

export interface Loaded {
  config: PaguConfig;
  /** Verbatim contents of environment.md (or "" if absent). */
  environment: string;
}

/** Merge a parsed config object onto a base, ignoring unknown/ill-typed
 * keys. Hand-rolled rather than a schema library — three fields don't
 * justify the dependency, and this keeps the trusted core small. */
export function mergeConfig(base: PaguConfig, parsed: unknown): PaguConfig {
  const out: PaguConfig = { ...base, allow: [...base.allow] };
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    if (typeof p.model === "string") out.model = p.model;
    if (typeof p.ollama === "string") out.ollama = p.ollama;
    if (Array.isArray(p.allow) && p.allow.every((x) => typeof x === "string")) {
      out.allow = p.allow as string[];
    }
  }
  return out;
}

function configDir(): string {
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  if (xdg) return `${xdg}/pagu`;
  return `${Deno.env.get("HOME") ?? "."}/.config/pagu`;
}

export async function loadConfig(): Promise<Loaded> {
  const dir = configDir();
  let config = { ...DEFAULTS };

  let raw: string | null = null;
  try {
    raw = await Deno.readTextFile(`${dir}/config.json`);
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
        `invalid ${dir}/config.json: ${e instanceof Error ? e.message : e}`,
      );
    }
    config = mergeConfig(config, parsed);
  }

  let environment = "";
  try {
    environment = (await Deno.readTextFile(`${dir}/environment.md`)).trim();
  } catch {
    // absent — no environment notes
  }

  return { config, environment };
}
