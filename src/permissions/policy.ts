// pure
import {
  type Envelope,
  type Permission,
  type PermissionSet,
  withinEnvelope,
} from "./envelope.ts";

/**
 * A run's permission policy: build its capability envelope and gate
 * auto-approve. (No relation to a conversation `session` — see sessions.ts.)
 *
 * Envelope: `read` paths the agent + scripts may read; `write` paths scripts
 * may write; `deny` paths (the concealment set's write-protection — see
 * `concealment.ts`) become write-denies so concealed secrets stay protected
 * even though the whole repo is granted. Pure: the caller resolves `deny`
 * (the git/glob enumeration is the effectful shell in setup.ts).
 */
export interface EnvelopeSpec {
  read: string[];
  write: string[];
  deny?: string[];
}

export function buildEnvelope(spec: EnvelopeSpec): Envelope {
  const allow: Permission[] = [
    ...spec.read.map((scope): Permission => ({ flag: "read", scope })),
    ...spec.write.map((scope): Permission => ({ flag: "write", scope })),
  ];
  const deny: Permission[] = (spec.deny ?? []).map((scope) => ({
    flag: "write",
    scope,
  }));
  return { allow, deny };
}

/**
 * Whether a cage-discovered permission set may be auto-approved. Two paths:
 * the session envelope (when `enabled`, e.g. repo mode), or an active **standing
 * grant** — a human-authored time-boxed allow-set (see `approval.ts`
 * `activeGrants`). Grants are **independent of `enabled`** (a grant *is* the
 * scoped+timed enabling), but each is checked with the **session's `deny`** so a
 * grant can never reach a concealed path — deny wins over a grant. Outside both
 * paths the human gate stands.
 */
export function shouldAutoApprove(
  discovered: Permission[],
  env: Envelope,
  enabled: boolean,
  grants: PermissionSet[] = [],
): boolean {
  if (enabled && withinEnvelope(discovered, env)) return true;
  return grants.some((allow) =>
    withinEnvelope(discovered, { allow, deny: env.deny })
  );
}
