// pure
import { type Envelope, type Permission, withinEnvelope } from "./envelope.ts";

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
 * Whether a cage-discovered permission set may be auto-approved: only when
 * auto-approve is `enabled` (e.g. repo mode) AND every discovered perm is
 * within the session envelope. Outside that, the human gate stands.
 */
export function shouldAutoApprove(
  discovered: Permission[],
  env: Envelope,
  enabled: boolean,
): boolean {
  return enabled && withinEnvelope(discovered, env);
}
