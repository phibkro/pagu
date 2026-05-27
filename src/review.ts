// pure: structured review analysis for the human approval gate
import {
  type Envelope,
  parsePermission,
  withinEnvelope,
} from "./permissions/envelope.ts";

/**
 * Risk tier derived from the permission set — computed without reading the
 * script body, so it's a fast triage signal before the human reads anything.
 *
 * external-net: script can reach the internet (exfil risk; output won't
 *   auto-return to the agent).
 * local-write-scoped: writes are confined, no network.
 * local-read-only: no writes or network; lowest blast radius.
 */
export type RiskTier =
  | "local-read-only"
  | "local-write-scoped"
  | "external-net";

export interface ReviewSummary {
  tier: RiskTier;
  /** Perms already covered by the session envelope (expected, no surprise). */
  insideEnvelope: string[];
  /** Perms outside the envelope — the ones that warrant attention. */
  outsideEnvelope: string[];
  /** Mismatches between --allow-run grants and Deno.Command calls in body. */
  runWarnings: string[];
  /** Unified-style diff if the script was revised during cage self-test. */
  diff: string;
}

function riskTier(perms: string[]): RiskTier {
  for (const p of perms) {
    try {
      const r = parsePermission(p);
      if (r.flag === "net" || r.flag === "all") return "external-net";
    } catch { /* skip unparseable */ }
  }
  for (const p of perms) {
    try {
      const r = parsePermission(p);
      if (r.flag === "write") return "local-write-scoped";
    } catch { /* skip */ }
  }
  return "local-read-only";
}

function partitionByEnvelope(
  perms: string[],
  envelope: Envelope,
): { inside: string[]; outside: string[] } {
  const inside: string[] = [];
  const outside: string[] = [];
  for (const perm of perms) {
    try {
      if (withinEnvelope([parsePermission(perm)], envelope)) {
        inside.push(perm);
      } else {
        outside.push(perm);
      }
    } catch {
      outside.push(perm); // unparseable = conservative
    }
  }
  return { inside, outside };
}

/**
 * LCS-based line diff with ±2 lines of context around each changed region.
 * Returns empty string when prev === next.
 */
export function lineDiff(prev: string, next: string): string {
  if (prev === next) return "";
  const al = prev.split("\n");
  const bl = next.split("\n");
  const m = al.length, n = bl.length;

  // Build LCS DP table
  const dp: number[][] = Array.from(
    { length: m + 1 },
    () => new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = al[i - 1] === bl[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Reconstruct edit script (right-to-left)
  type Op = " " | "+" | "-";
  const edits: Array<{ op: Op; line: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && al[i - 1] === bl[j - 1]) {
      edits.unshift({ op: " ", line: al[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.unshift({ op: "+", line: bl[j - 1] });
      j--;
    } else {
      edits.unshift({ op: "-", line: al[i - 1] });
      i--;
    }
  }

  // Collect indices to show (changed ± CONTEXT)
  const CONTEXT = 2;
  const shown = new Set<number>();
  for (let k = 0; k < edits.length; k++) {
    if (edits[k].op !== " ") {
      for (
        let c = Math.max(0, k - CONTEXT);
        c <= Math.min(edits.length - 1, k + CONTEXT);
        c++
      ) shown.add(c);
    }
  }

  const indices = [...shown].sort((a, b) => a - b);
  const lines: string[] = [];
  let last = -1;
  for (const idx of indices) {
    if (last >= 0 && idx > last + 1) lines.push("...");
    lines.push(`${edits[idx].op} ${edits[idx].line}`);
    last = idx;
  }
  return lines.join("\n");
}

/**
 * Check that every --allow-run scope has a matching Deno.Command call in the
 * script body. A grant with no visible call is worth flagging — either the
 * script doesn't need it, or the command is constructed dynamically (which
 * itself warrants attention).
 *
 * Only checks one direction: granted-but-not-called. A Deno.Command call for
 * a binary not in --allow-run would be caught by the cage self-test anyway.
 */
export function checkRunTargets(body: string, perms: string[]): string[] {
  const runScopes = perms.flatMap((p) => {
    try {
      const r = parsePermission(p);
      return r.flag === "run" && r.scope ? [r.scope] : [];
    } catch {
      return [];
    }
  });
  if (runScopes.length === 0) return [];

  const cmdRe = /new\s+Deno\.Command\s*\(\s*["']([^"']+)["']/g;
  const called = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = cmdRe.exec(body)) !== null) called.add(match[1]);

  return runScopes
    .filter((scope) => {
      const base = scope.split("/").at(-1) ?? scope;
      return ![...called].some((c) => c === scope || c === base);
    })
    .map((scope) => `allow-run=${scope} granted but Deno.Command not found`);
}

export function buildReview(params: {
  perms: string[];
  envelope: Envelope;
  body: string;
  /** Supply to get a diff — omit when there was no cage revision. */
  prevBody?: string;
}): ReviewSummary {
  const { perms, envelope, body, prevBody } = params;
  const { inside, outside } = partitionByEnvelope(perms, envelope);
  return {
    tier: riskTier(perms),
    insideEnvelope: inside,
    outsideEnvelope: outside,
    runWarnings: checkRunTargets(body, perms),
    diff: prevBody !== undefined ? lineDiff(prevBody, body) : "",
  };
}

const TIER_LABEL: Record<RiskTier, string> = {
  "local-read-only": "read-only",
  "local-write-scoped": "local-write",
  "external-net": "EXTERNAL-NET",
};

export function formatReview(
  s: ReviewSummary,
  scriptId: string,
  lang: string,
  body: string,
): string {
  const parts: string[] = [];

  const revised = s.diff ? " · revised" : "";
  parts.push(
    `\n--- ${scriptId} (${lang}) · ${TIER_LABEL[s.tier]}${revised} ---`,
  );

  if (s.diff) {
    parts.push(`\nchanges:\n${s.diff}\n\nfull script:`);
  }
  parts.push(body);

  parts.push("\npermissions:");
  if (s.insideEnvelope.length === 0 && s.outsideEnvelope.length === 0) {
    parts.push("  (none)");
  } else {
    for (const p of s.insideEnvelope) parts.push(`  ${p}  (envelope ✓)`);
    for (const p of s.outsideEnvelope) parts.push(`  ${p}  ← outside envelope`);
  }

  for (const w of s.runWarnings) parts.push(`\n⚠ ${w}`);

  return parts.join("\n");
}
