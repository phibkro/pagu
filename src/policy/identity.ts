// pure: canonical policy identity used to bind grants to decision authority.
import type { PolicyV0 } from "./schema.ts";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")
  }}`;
}

/** Collision-resistant identity of the complete policy used for a decision. */
export async function policyIdentity(policy: PolicyV0): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(policy));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${
    [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}
