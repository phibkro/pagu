// pure: trusted-user policy folded with an untrusted narrow-only project layer.
import { EMPTY_POLICY, parsePolicy, type PolicyV0 } from "./schema.ts";
import {
  type CapabilityPathContext,
  capabilityPathCovered,
  narrowCapabilityPath,
} from "./path.ts";

export interface PolicyLayers {
  /** Operator-authored standing policy. Absent means deny-all. */
  readonly user?: unknown;
  /** Repo-authored policy. When present, every authority field is attenuation. */
  readonly project?: unknown;
}

export interface PolicyLoadContext extends CapabilityPathContext {}

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

function equalRule(
  a: PolicyV0["escalation"]["auto"][number],
  b: PolicyV0["escalation"]["auto"][number],
  context?: PolicyLoadContext,
): boolean {
  return capabilityPathCovered(a["fs.ro"], b["fs.ro"], context, "pattern") &&
    a.scope === b.scope;
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

  const userRw = user.fs.home === "rw" ? [...user.fs.rw, "$HOME"] : user.fs.rw;
  const rw = project.fs.rw.flatMap((candidate) => {
    const narrowed = narrowCapabilityPath(userRw, candidate, context);
    if (narrowed === null) {
      warn(`ignored fs.rw widening ${JSON.stringify(candidate)}`);
      return [];
    }
    return [narrowed];
  });

  // A trusted RW scope may be attenuated to RO by the project.
  const ro = project.fs.ro.flatMap((candidate) => {
    const narrowed = narrowCapabilityPath(
      [...userRw, ...user.fs.ro],
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
