// pure: trusted-user policy folded with an untrusted narrow-only project layer.
import { EMPTY_POLICY, parsePolicy, type PolicyV0 } from "./schema.ts";

export interface PolicyLayers {
  /** Operator-authored standing policy. Absent means deny-all. */
  readonly user?: unknown;
  /** Repo-authored policy. When present, every authority field is attenuation. */
  readonly project?: unknown;
}

export interface PolicyLoadContext {
  /** Resolve a schema path to its canonical host path. Returning null fails
   * closed. Required before accepting a project path nested below a user path. */
  readonly canonicalize: (path: string) => string | null;
}

export interface LoadedPolicy {
  readonly policy: PolicyV0;
  /** Widening attempts ignored during the project fold. Adapters must surface
   * these; returning them keeps the SDK core pure and testable. */
  readonly warnings: readonly string[];
}

const union = (
  a: readonly string[],
  b: readonly string[],
): string[] => [...new Set([...a, ...b])];

function normalizeCapabilityPath(path: string): string | null {
  let value = path.endsWith("/**") ? path.slice(0, -3) : path;
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
      // A project path may normalize within a trusted root, but must never
      // traverse above an absolute or symbolic ($PWD/$HOME/~) root.
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

/** Lexical containment over schema paths (`$PWD`, `~`, and absolute paths).
 * Runtime canonicalization belongs to compilation/enforcement; this fold only
 * proves that a repo's child scope is syntactically within a trusted parent. */
function pathCovered(
  parent: string,
  child: string,
  context?: PolicyLoadContext,
): boolean {
  const p = normalizeCapabilityPath(parent);
  const c = normalizeCapabilityPath(child);
  if (p === null || c === null) return false;
  if (c === p) return true;
  if (!context) return false;
  const canonicalParent = context.canonicalize(p);
  const canonicalChild = context.canonicalize(c);
  if (canonicalParent === null || canonicalChild === null) return false;
  return canonicalChild === canonicalParent ||
    canonicalChild.startsWith(
      canonicalParent === "/" ? "/" : `${canonicalParent}/`,
    );
}

function narrowedPath(
  parents: readonly string[],
  candidate: string,
  context?: PolicyLoadContext,
): string | null {
  const normalizedCandidate = normalizeCapabilityPath(candidate);
  if (normalizedCandidate === null) return null;
  for (const parent of parents) {
    const normalizedParent = normalizeCapabilityPath(parent);
    if (normalizedParent === normalizedCandidate) return candidate;
    if (pathCovered(parent, candidate, context)) {
      // Nested project paths are returned canonical, closing the symlink/TOCTOU
      // alias between attenuation and later bwrap compilation.
      return context?.canonicalize(normalizedCandidate) ?? null;
    }
  }
  return null;
}

function equalRule(
  a: PolicyV0["escalation"]["auto"][number],
  b: PolicyV0["escalation"]["auto"][number],
  context?: PolicyLoadContext,
): boolean {
  return pathCovered(a["fs.ro"], b["fs.ro"], context) && a.scope === b.scope;
}

function narrowProject(
  user: PolicyV0,
  project: PolicyV0,
  context?: PolicyLoadContext,
): LoadedPolicy {
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(`project policy: ${message}`);

  const home = user.fs.home === "rw" && project.fs.home === "tmpfs"
    ? "tmpfs"
    : user.fs.home;
  if (user.fs.home === "tmpfs" && project.fs.home === "rw") {
    warn("ignored fs.home=rw widening");
  }

  const rw = project.fs.rw.flatMap((candidate) => {
    const narrowed = narrowedPath(user.fs.rw, candidate, context);
    if (narrowed === null) {
      warn(`ignored fs.rw widening ${JSON.stringify(candidate)}`);
      return [];
    }
    return [narrowed];
  });

  // A trusted RW scope may be attenuated to RO by the project.
  const ro = project.fs.ro.flatMap((candidate) => {
    const narrowed = narrowedPath(
      [...user.fs.rw, ...user.fs.ro],
      candidate,
      context,
    );
    if (narrowed === null) {
      warn(`ignored fs.ro widening ${JSON.stringify(candidate)}`);
      return [];
    }
    return [narrowed];
  });

  if (!user.net && project.net) warn("ignored net=true widening");

  const pass = project.env.pass.filter((name) => {
    const allowed = user.env.pass.includes(name);
    if (!allowed) warn(`ignored env.pass widening ${JSON.stringify(name)}`);
    return allowed;
  });

  const auto = project.escalation.auto.filter((candidate) => {
    const allowed = user.escalation.auto.some((rule) =>
      equalRule(rule, candidate, context)
    );
    if (!allowed) {
      warn(`ignored escalation.auto widening ${JSON.stringify(candidate)}`);
    }
    return allowed;
  });

  if (
    project.subject.agent !== "" || project.subject.label !== ""
  ) {
    if (
      project.subject.agent !== user.subject.agent ||
      project.subject.label !== user.subject.label
    ) {
      warn("ignored project subject override");
    }
  }

  return {
    policy: {
      version: 0,
      subject: user.subject,
      fs: {
        home,
        rw,
        ro,
        deny: union(user.fs.deny, project.fs.deny),
      },
      net: user.net && project.net,
      env: { pass },
      escalation: {
        auto,
        refuse: union(
          user.escalation.refuse,
          project.escalation.refuse,
        ),
      },
    },
    warnings,
  };
}

/** Fold operator policy with an optional repo policy. Both artifacts are
 * strictly decoded first; a present empty project policy attenuates to bottom. */
export function loadPolicy(
  layers: PolicyLayers,
  context?: PolicyLoadContext,
): LoadedPolicy {
  const user = layers.user === undefined
    ? EMPTY_POLICY
    : parsePolicy(layers.user);
  if (layers.project === undefined) return { policy: user, warnings: [] };
  return narrowProject(user, parsePolicy(layers.project), context);
}
