// pure: fail-closed validation of requested permissions against a ceiling.
import {
  absolutizePerm,
  parsePermission,
  type Permission,
  withinEnvelope,
} from "../permissions/index.ts";

/** `parsePermission` preserves a legacy tolerance for `allow-all=<scope>` by
 * dropping the meaningless scope. A ceiling must be stricter: accepting that
 * typo would turn an apparently scoped declaration into universal authority. */
function parseCeilingPermission(permission: string): Permission {
  const normalized = permission.replace(/^--/, "").trim();
  if (/^allow-all=/.test(normalized)) {
    throw new Error("allow-all cannot be scoped");
  }
  return parsePermission(permission);
}

/**
 * Validate a discovered permission set against a declared ceiling.
 *
 * Path permissions on both sides are resolved against `base` before the
 * comparison. On success the normalized requested flags are returned for
 * persistence or enforcement. A malformed permission or an exceeded ceiling
 * returns `null`: invalid input can only narrow authority.
 */
export function validateCeiling(
  requested: readonly string[],
  declared: readonly string[],
  base: string,
): string[] | null {
  try {
    const normalizedRequested = requested.map((permission) =>
      absolutizePerm(permission, base)
    );
    const normalizedDeclared = declared.map((permission) =>
      absolutizePerm(permission, base)
    );
    const requestedSet = normalizedRequested.map(parseCeilingPermission);
    const ceiling = normalizedDeclared.map(parseCeilingPermission);

    return withinEnvelope(requestedSet, { allow: ceiling })
      ? normalizedRequested
      : null;
  } catch {
    return null;
  }
}
