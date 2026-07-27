// pure: legacy box profiles generated as schema-v0 policy values.
import {
  BUILTIN_SECRET_DENY,
  NET_HOST,
  NET_OFF,
  type PolicyNetV0,
  type PolicyV0,
} from "./schema.ts";
import { CATEGORY_SECRET_FLOOR } from "./profiles.ts";

export type LegacyPolicyProfile =
  | "default"
  | "strict"
  | "paranoid"
  | "loose";

const COMMON_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
] as const;

const DEFAULT_DENY = CATEGORY_SECRET_FLOOR;

function preset(
  name: LegacyPolicyProfile,
  home: "rw" | "tmpfs",
  net: PolicyNetV0,
  deny: readonly string[],
): PolicyV0 {
  return {
    version: 0,
    subject: { agent: "", label: `legacy:${name}` },
    fs: {
      home,
      rw: ["$PWD"],
      ro: [],
      deny: [...new Set([...BUILTIN_SECRET_DENY, ...deny])],
      // The legacy baselines predate derived mounts and grant no placement.
      derive: [],
    },
    net,
    env: { pass: [...COMMON_ENV] },
    escalation: { auto: [], refuse: [] },
  };
}

/** Generated schema representations of the compatibility profiles. The legacy
 * launcher remains intact until its flag algebra can move without drift. */
export const LEGACY_POLICY_PRESETS: Readonly<
  Record<LegacyPolicyProfile, PolicyV0>
> = {
  default: preset("default", "rw", NET_HOST, DEFAULT_DENY),
  strict: preset("strict", "tmpfs", NET_HOST, []),
  paranoid: preset("paranoid", "tmpfs", NET_OFF, []),
  loose: preset("loose", "rw", NET_HOST, ["~/.ssh", "~/.gnupg"]),
};
