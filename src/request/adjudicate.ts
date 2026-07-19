// pure: policy-tier selection; effects enter only through the Approver port.
import type { PolicyV0 } from "../policy/schema.ts";
import type { GateDecision, GateRequest, OperatorDecision } from "./schema.ts";

export type GateApprover = (
  request: GateRequest,
) => Promise<OperatorDecision>;

export interface AdjudicationContext {
  /** Resolve an exact schema path to its canonical host path. Null fails
   * closed for auto-escalation. */
  readonly canonicalize: (path: string) => string | null;
}

function normalizedRoot(path: string): string | null {
  let value = path.endsWith("/**") ? path.slice(0, -3) : path;
  let prefix: string;
  if (value === "$HOME" || value.startsWith("$HOME/")) {
    prefix = "~";
    value = value.slice(5);
  } else if (value === "~" || value.startsWith("~/")) {
    prefix = "~";
    value = value.slice(1);
  } else if (value === "$PWD" || value.startsWith("$PWD/")) {
    prefix = "$PWD";
    value = value.slice(4);
  } else if (value.startsWith("/")) {
    prefix = "";
  } else {
    return null;
  }
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  const suffix = parts.join("/");
  if (prefix === "") return suffix === "" ? "/" : `/${suffix}`;
  return suffix === "" ? prefix : `${prefix}/${suffix}`;
}

function covered(parent: string, child: string): boolean {
  const p = normalizedRoot(parent);
  const c = normalizedRoot(child);
  if (p === null || c === null) return false;
  return c === p || c.startsWith(p === "/" ? "/" : `${p}/`);
}

export async function adjudicateRequest(
  policy: PolicyV0,
  request: GateRequest,
  approver: GateApprover,
  context: AdjudicationContext,
): Promise<GateDecision> {
  const requested = request.suggested_rule["fs.ro"];
  const canonicalRequested = context.canonicalize(requested);
  if (
    policy.escalation.refuse.some((path) =>
      covered(path, requested) ||
      (canonicalRequested !== null && (() => {
        const canonicalRefuse = context.canonicalize(path);
        return canonicalRefuse !== null &&
          covered(canonicalRefuse, canonicalRequested);
      })())
    )
  ) {
    return {
      verdict: "deny",
      scope: null,
      tier: "refuse",
      rationale: "refused by standing policy",
    };
  }
  if (
    canonicalRequested !== null && policy.escalation.auto.some((rule) => {
      if (!covered(rule["fs.ro"], requested)) return false;
      const canonicalAuto = context.canonicalize(rule["fs.ro"]);
      return canonicalAuto !== null &&
        covered(canonicalAuto, canonicalRequested);
    })
  ) {
    return {
      verdict: "approve",
      scope: "session",
      tier: "auto",
      rationale: "approved within standing auto-escalation scope",
      granted_rule: { "fs.ro": requested },
    };
  }
  const decision = await approver(request);
  if (decision.verdict === "deny") {
    return {
      verdict: "deny",
      scope: null,
      tier: "operator",
      rationale: "denied by operator",
    };
  }
  return {
    verdict: "approve",
    scope: decision.scope,
    tier: "operator",
    rationale: `approved by operator for ${decision.scope}`,
    granted_rule: { "fs.ro": requested },
  };
}
