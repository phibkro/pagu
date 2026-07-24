// pure: canonical capability-path normalization and containment.

export interface CapabilityPathContext {
  /** Resolve a normalized schema path to its canonical path. Null fails closed. */
  readonly canonicalize: (path: string) => string | null;
}

export type CapabilityPathSemantics = "exact" | "pattern";

/** Normalize absolute and symbolic schema paths without permitting root escape. */
export function normalizeCapabilityPath(
  path: string,
  semantics: CapabilityPathSemantics = "exact",
): string | null {
  let value = semantics === "pattern" && path.endsWith("/**")
    ? path.slice(0, -3)
    : path;
  let root: string;
  if (value === "$PWD" || value.startsWith("$PWD/")) {
    root = "$PWD";
    value = value.slice(4);
  } else if (value === "$HOME" || value.startsWith("$HOME/")) {
    root = "$HOME";
    value = value.slice(5);
  } else if (value === "~" || value.startsWith("~/")) {
    root = "~";
    value = value.slice(1);
  } else if (value.startsWith("/")) {
    root = "";
  } else {
    return null;
  }

  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const suffix = segments.join("/");
  if (root === "") return suffix === "" ? "/" : `/${suffix}`;
  return suffix === "" ? root : `${root}/${suffix}`;
}

/** Exact paths compare lexically after normalization. Nested authority requires
 * canonical containment so aliases and symlinks cannot escape the parent. */
export function capabilityPathCovered(
  parent: string,
  child: string,
  context?: CapabilityPathContext,
  semantics: CapabilityPathSemantics = "exact",
): boolean {
  const normalizedParent = normalizeCapabilityPath(parent, semantics);
  const normalizedChild = normalizeCapabilityPath(child, semantics);
  if (normalizedParent === null || normalizedChild === null) return false;
  if (normalizedChild === normalizedParent) return true;
  if (!context) return false;
  const canonicalParent = context.canonicalize(normalizedParent);
  const canonicalChild = context.canonicalize(normalizedChild);
  if (canonicalParent === null || canonicalChild === null) return false;
  return canonicalChild === canonicalParent ||
    canonicalChild.startsWith(
      canonicalParent === "/" ? "/" : `${canonicalParent}/`,
    );
}

/** Return the accepted child scope. Nested scopes are returned canonical so the
 * same material can proceed to compilation without retaining a symlink alias. */
export function narrowCapabilityPath(
  parents: readonly string[],
  candidate: string,
  context?: CapabilityPathContext,
  semantics: CapabilityPathSemantics = "exact",
): string | null {
  const normalizedCandidate = normalizeCapabilityPath(candidate, semantics);
  if (normalizedCandidate === null) return null;
  for (const parent of parents) {
    const normalizedParent = normalizeCapabilityPath(parent, semantics);
    if (normalizedParent === normalizedCandidate) return candidate;
    if (capabilityPathCovered(parent, candidate, context, semantics)) {
      return context?.canonicalize(normalizedCandidate) ?? null;
    }
  }
  return null;
}
