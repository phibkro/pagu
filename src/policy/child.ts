// pure: strict child-policy derivation from an effective parent authority.
import { type CapabilityPathContext, narrowCapabilityPath } from "./path.ts";
import { parsePolicy, type PolicyV0 } from "./schema.ts";

export interface ChildPolicyContext extends CapabilityPathContext {}

export class ChildPolicyAttenuationError extends Error {
  override name = "ChildPolicyAttenuationError";

  constructor(readonly violations: readonly string[]) {
    super(`child policy exceeds parent authority: ${violations.join("; ")}`);
  }
}

const union = (
  parent: readonly string[],
  child: readonly string[],
): string[] => [...new Set([...parent, ...child])];

function wildcard(path: string): boolean {
  return path.endsWith("/**");
}

function restoreWildcard(path: string, candidate: string): string {
  if (!wildcard(candidate)) return path;
  return `${path.replace(/\/+$/, "")}/**`;
}

/** Derive a complete child policy or reject the whole proposal. Unlike the
 * hostile project fold, this never silently drops requested authority. */
export function deriveChildPolicy(
  parentInput: unknown,
  childInput: unknown,
  context: ChildPolicyContext,
): PolicyV0 {
  const parent = parsePolicy(parentInput);
  const child = parsePolicy(childInput);
  const violations: string[] = [];

  if (parent.fs.home === "tmpfs" && child.fs.home === "rw") {
    violations.push("fs.home=rw would regain ancestor host home");
  }

  const parentRw = parent.fs.home === "rw"
    ? [...parent.fs.rw, "$HOME"]
    : parent.fs.rw;
  const rw = child.fs.rw.flatMap((candidate) => {
    const narrowed = narrowCapabilityPath(parentRw, candidate, context);
    if (narrowed === null) {
      violations.push(`fs.rw widening ${JSON.stringify(candidate)}`);
      return [];
    }
    return [narrowed];
  });

  const ro = child.fs.ro.flatMap((candidate) => {
    const narrowed = narrowCapabilityPath(
      [...parentRw, ...parent.fs.ro],
      candidate,
      context,
    );
    if (narrowed === null) {
      violations.push(`fs.ro widening ${JSON.stringify(candidate)}`);
      return [];
    }
    return [narrowed];
  });

  if (!parent.net && child.net) {
    violations.push("net=true would regain ancestor network");
  }

  for (const name of child.env.pass) {
    if (!parent.env.pass.includes(name)) {
      violations.push(`env.pass widening ${JSON.stringify(name)}`);
    }
  }

  const auto = child.escalation.auto.flatMap((candidate) => {
    for (const rule of parent.escalation.auto) {
      if (rule.scope !== candidate.scope) continue;
      const narrowed = narrowCapabilityPath(
        [rule["fs.ro"]],
        candidate["fs.ro"],
        context,
        "pattern",
      );
      if (narrowed !== null) {
        return [{
          "fs.ro": restoreWildcard(narrowed, candidate["fs.ro"]),
          scope: candidate.scope,
        }];
      }
    }
    violations.push(
      `escalation.auto widening ${JSON.stringify(candidate)}`,
    );
    return [];
  });

  if (violations.length > 0) {
    throw new ChildPolicyAttenuationError(violations);
  }

  return parsePolicy({
    version: 0,
    subject: child.subject,
    fs: {
      home: child.fs.home,
      rw,
      ro,
      deny: union(parent.fs.deny, child.fs.deny),
    },
    net: parent.net && child.net,
    env: { pass: child.env.pass },
    escalation: {
      auto,
      refuse: union(
        parent.escalation.refuse,
        child.escalation.refuse,
      ),
    },
  });
}
