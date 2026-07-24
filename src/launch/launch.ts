// pure: parseLaunchConfig/inferHarness/resolveLaunch; effects: loadLaunchConfig
import {
  type CategoryProfileName,
  isCategoryProfile,
} from "../policy/index.ts";

export type HarnessName = "codex" | "claude";

export interface LaunchDefaultsV0 {
  readonly harness: HarnessName;
  readonly profile: CategoryProfileName;
}

/** Trusted, user-owned defaults for the human `pagu` launch journey. */
export interface LaunchConfigV0 {
  readonly version: 0;
  readonly defaults: LaunchDefaultsV0;
}

export const DEFAULT_LAUNCH_CONFIG: LaunchConfigV0 = {
  version: 0,
  defaults: {
    harness: "codex",
    profile: "worker",
  },
};

export interface LaunchRequest {
  readonly harness?: HarnessName;
  readonly profile?: CategoryProfileName;
  /** A single executable. Harness-owned argv is added by its verified adapter. */
  readonly executable?: string;
}

export interface ResolvedLaunch {
  readonly harness: HarnessName;
  readonly profile: CategoryProfileName;
  readonly executable: string;
}

export interface LaunchConfigEnvironment {
  readonly xdgConfigHome?: string;
  readonly home?: string;
}

function joinPath(root: string, ...parts: readonly string[]): string {
  return [root.replace(/[\\/]+$/, ""), ...parts].join("/");
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${at} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  at: string,
): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${at} has unknown field ${JSON.stringify(unknown[0])}`);
  }
}

/** Decode the versioned launch-default schema. Unknown fields fail loud. */
export function parseLaunchConfig(value: unknown): LaunchConfigV0 {
  const root = record(value, "launch config");
  exactKeys(root, ["version", "defaults"], "launch config");
  if (root.version !== 0) {
    throw new Error("launch config version must be 0");
  }
  const defaults = record(root.defaults, "launch config defaults");
  exactKeys(defaults, ["harness", "profile"], "launch config defaults");
  if (defaults.harness !== "codex" && defaults.harness !== "claude") {
    throw new Error("launch config defaults.harness must be codex or claude");
  }
  if (
    typeof defaults.profile !== "string" ||
    !isCategoryProfile(defaults.profile)
  ) {
    throw new Error("launch config defaults.profile is not a category profile");
  }
  return {
    version: 0,
    defaults: {
      harness: defaults.harness,
      profile: defaults.profile,
    },
  };
}

/** The root launch config is separate from the archived harness config schema. */
export function launchConfigPath(
  environment: LaunchConfigEnvironment = {
    xdgConfigHome: Deno.env.get("XDG_CONFIG_HOME"),
    home: Deno.env.get("HOME"),
  },
): string {
  const root = environment.xdgConfigHome ??
    joinPath(environment.home ?? ".", ".config");
  return joinPath(root, "pagu", "launch.json");
}

/** Load trusted user defaults. Absence means the built-in worker Codex default. */
export async function loadLaunchConfig(
  path = launchConfigPath(),
): Promise<LaunchConfigV0> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return DEFAULT_LAUNCH_CONFIG;
    throw error;
  }
  try {
    return parseLaunchConfig(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `invalid ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/** Infer only adapters whose fresh/resume lifecycle is verified by pagu. */
export function inferHarness(executable: string): HarnessName | null {
  const name = executable.replaceAll("\\", "/").split("/").at(-1)
    ?.toLowerCase().replace(/\.exe$/, "");
  if (name === "codex" || name === "claude") return name;
  return null;
}

/** Resolve user/config/argv intent before the CLI performs any effects. */
export function resolveLaunch(
  config: LaunchConfigV0,
  request: LaunchRequest = {},
): ResolvedLaunch {
  const inferred = request.executable ? inferHarness(request.executable) : null;
  if (request.harness && inferred && request.harness !== inferred) {
    throw new Error(
      `--harness ${request.harness} conflicts with wrapped ${inferred} executable`,
    );
  }
  if (request.executable && !request.harness && !inferred) {
    throw new Error(
      "cannot infer harness from wrapped executable; pass --harness codex|claude",
    );
  }
  const harness = request.harness ?? inferred ?? config.defaults.harness;
  return {
    harness,
    profile: request.profile ?? config.defaults.profile,
    executable: request.executable ?? harness,
  };
}
