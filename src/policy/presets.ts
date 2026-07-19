// pure: legacy box profiles generated as schema-v0 policy values.
import { BUILTIN_SECRET_DENY, type PolicyV0 } from "./schema.ts";

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

const DEFAULT_DENY = [
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.azure",
  "~/.config/sops",
  "~/.config/age",
  "~/.config/gh",
  "~/.config/op",
  "~/.config/gcloud",
  "~/.password-store",
  "~/.netrc",
  "~/.bash_history",
  "~/.zsh_history",
  "~/.python_history",
] as const;

function preset(
  name: LegacyPolicyProfile,
  home: "rw" | "tmpfs",
  net: boolean,
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
  default: preset("default", "rw", true, DEFAULT_DENY),
  strict: preset("strict", "tmpfs", true, []),
  paranoid: preset("paranoid", "tmpfs", false, []),
  loose: preset("loose", "rw", true, ["~/.ssh", "~/.gnupg"]),
};
