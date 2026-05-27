import {
  type Envelope,
  type Permission,
  withinEnvelope,
} from "./perms/envelope.ts";
import { gitignoreDenies } from "./perms/gitignore.ts";

/**
 * Session capability envelope. `read` paths the agent + scripts may read;
 * `write` paths scripts may write; when `repo` is set (repo mode), the
 * repo's `.gitignore`'d paths are added as denies so secrets stay
 * protected even though the whole repo is granted.
 */
export interface EnvelopeSpec {
  read: string[];
  write: string[];
  repo?: string;
}

export async function buildEnvelope(spec: EnvelopeSpec): Promise<Envelope> {
  const allow: Permission[] = [
    ...spec.read.map((scope): Permission => ({ flag: "read", scope })),
    ...spec.write.map((scope): Permission => ({ flag: "write", scope })),
  ];
  const deny = spec.repo ? await gitignoreDenies(spec.repo) : [];
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
