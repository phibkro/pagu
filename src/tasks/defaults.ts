// pure: the vetted default command rules + lookup. Each is read-only
// (ceiling carries no write/net) so its free args are safe by the grammar law.
import type { CommandRule } from "./grammar.ts";

/**
 * Built-in read-only commands the agent may run with validated free args. The
 * flag allowlists deliberately EXCLUDE every code-exec / escape vector
 * (`rg --pre`, `git -c`, …): default-deny, canonical flags only.
 */
export const DEFAULT_RULES: CommandRule[] = [
  {
    program: "rg",
    prefix: [],
    flags: [
      { name: "-i" },
      { name: "--ignore-case" },
      { name: "-n" },
      { name: "--line-number" },
      { name: "-F" },
      { name: "--fixed-strings" },
      { name: "-w" },
      { name: "--word-regexp" },
      { name: "-C", value: "int" },
      { name: "-A", value: "int" },
      { name: "-B", value: "int" },
      { name: "-m", value: "int" },
      { name: "--max-count", value: "int" },
      { name: "-t", value: "string" },
      { name: "--type", value: "string" },
    ],
    // pattern (opaque-safe) + up to 7 contained paths.
    positionals: { slots: ["string"], rest: "path", min: 1, max: 8 },
    ceiling: [],
    source: "default",
  },
  {
    program: "git",
    prefix: ["log"],
    flags: [
      { name: "--oneline" },
      { name: "--stat" },
      { name: "-p" },
      { name: "-n", value: "int" },
    ],
    positionals: { slots: [], rest: "path", min: 0, max: 4 },
    ceiling: [],
    source: "default",
  },
  {
    program: "git",
    prefix: ["diff"],
    flags: [
      { name: "--stat" },
      { name: "--name-only" },
      { name: "--cached" },
    ],
    positionals: { slots: [], rest: "path", min: 0, max: 4 },
    ceiling: [],
    source: "default",
  },
];

/** Find the default rule whose program + prefix matches this invocation. */
export function findDefaultRule(
  program: string,
  args: string[],
): CommandRule | undefined {
  return DEFAULT_RULES.find(
    (r) => r.program === program && r.prefix.every((p, i) => args[i] === p),
  );
}
