// pure: the gated-egress precondition. Observation happens in an adapter.

import type { PolicyNetV0 } from "./schema.ts";

/** A gated policy could not prove its gateway. Launch must stop here. */
export class GatewayUnavailableError extends Error {
  override name = "GatewayUnavailableError";

  constructor(reason: string) {
    super(
      `gated egress requires a gateway: ${reason}\n` +
        "  launch inside one: clawpatrol run -- pagu HARNESS",
    );
  }
}

/**
 * Namespace facts read from the host, never from policy or agent-supplied text.
 *
 * `netns` is the launching process's network namespace; `gatewayNetns` is the
 * namespace the gateway actually owns, or null when no gateway was found.
 */
export interface GatewayFacts {
  readonly netns: string;
  readonly gatewayNetns: string | null;
}

/**
 * Gated egress is the one mode pagu cannot enforce alone: pagu owns the
 * namespace, an outside gateway owns what may leave it. If the gateway is
 * absent, `--share-net` inherits whatever namespace the launcher happened to
 * be in — which is the open internet. That is a weaker mode reached by
 * omission, so it fails loud instead.
 *
 * Identity is compared rather than trusted: an environment variable announcing
 * a gateway is narration, while sharing its exact network namespace is
 * evidence. `off` and `host` state their authority completely and need no
 * proof.
 */
// pure:
export function requireGateway(net: PolicyNetV0, facts: GatewayFacts): void {
  if (net.mode !== "gated") return;
  if (facts.gatewayNetns === null) {
    throw new GatewayUnavailableError("no gateway namespace was observed");
  }
  if (facts.gatewayNetns !== facts.netns) {
    throw new GatewayUnavailableError(
      `launcher is in ${facts.netns}, gateway owns ${facts.gatewayNetns}`,
    );
  }
}
