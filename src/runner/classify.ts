// pure
/**
 * Classify a cage self-test run. The cage grants only read-allowlist +
 * scratch-write and no net, so any *permission* denial reveals a real
 * permission the script wants (discovery) rather than a defect, while a
 * non-permission failure is a code bug to feed back to the Author phase.
 */
export type RunClass =
  | { kind: "ok" }
  | { kind: "needs-perms"; perms: string[] }
  | { kind: "bug"; error: string };

// Deno denials look like: `Requires write access to "/x", run again ...`
// or `Requires env access`. Capture the flag and (optional) target.
const PERM_RE =
  /Requires (read|write|net|run|env|sys|ffi|import) access(?: to "([^"]+)")?/g;

export function classifyRun(exit: number, stderr: string): RunClass {
  if (exit === 0) return { kind: "ok" };

  const perms: string[] = [];
  PERM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PERM_RE.exec(stderr)) !== null) {
    perms.push(m[2] ? `allow-${m[1]}=${m[2]}` : `allow-${m[1]}`);
  }
  if (perms.length > 0) {
    return { kind: "needs-perms", perms: [...new Set(perms)] };
  }

  return { kind: "bug", error: stderr.trim() };
}
