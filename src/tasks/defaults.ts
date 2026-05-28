// pure: the default command rules + lookup + availability filter.
// effects: programOnPath (PATH probe). Each rule is read-only (ceiling carries
// no write/net) so its free args are safe by the grammar law.
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

/** Keep only rules whose program is present (advertise = legal ∩ available).
 * Pure — the presence predicate is injected so it stays testable. */
export function availableRules(
  rules: CommandRule[],
  present: (program: string) => boolean,
): CommandRule[] {
  return rules.filter((r) => present(r.program));
}

/** True if `program` is an executable on PATH. Scans (no exec) so checking
 * presence never runs the program. */
export async function programOnPath(program: string): Promise<boolean> {
  const sep = Deno.build.os === "windows" ? ";" : ":";
  const exts = Deno.build.os === "windows"
    ? (Deno.env.get("PATHEXT")?.split(";") ?? [".EXE"])
    : [""];
  for (const dir of (Deno.env.get("PATH") ?? "").split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if ((await Deno.stat(`${dir}/${program}${ext}`)).isFile) return true;
      } catch { /* not in this dir */ }
    }
  }
  return false;
}

/** The default rules whose program is installed on this machine. */
export async function presentDefaultRules(): Promise<CommandRule[]> {
  const present = new Set<string>();
  for (const p of new Set(DEFAULT_RULES.map((r) => r.program))) {
    if (await programOnPath(p)) present.add(p);
  }
  return availableRules(DEFAULT_RULES, (p) => present.has(p));
}
