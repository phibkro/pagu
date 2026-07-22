// pure: strict schema for supervisor-owned denial evidence JSONL.

export interface DenialEvidenceV1 {
  readonly version: 1;
  readonly syscall: "open" | "openat";
  readonly path: string;
  readonly verdict: "deny";
  readonly ts: string;
  readonly profile?: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isLexicallyCanonicalAbsolutePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path === "/") return true;
  if (path.endsWith("/")) return false;
  return path.slice(1).split("/").every((part) =>
    part.length > 0 && part !== "." && part !== ".."
  );
}

export function decodeDenialEvidence(value: unknown): DenialEvidenceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("denial evidence must be an object");
  }
  const item = value as Record<string, unknown>;
  const allowed = ["version", "syscall", "path", "verdict", "ts", "profile"];
  if (Object.keys(item).some((key) => !allowed.includes(key))) {
    throw new Error("denial evidence has unknown fields");
  }
  if (item.version !== 1) {
    throw new Error("unsupported denial evidence version");
  }
  if (item.syscall !== "open" && item.syscall !== "openat") {
    throw new Error("invalid denial syscall");
  }
  if (
    typeof item.path !== "string" ||
    !isLexicallyCanonicalAbsolutePath(item.path)
  ) {
    throw new Error("denial path must be lexically canonical and absolute");
  }
  if (item.verdict !== "deny") throw new Error("invalid denial verdict");
  if (typeof item.ts !== "string" || !TIMESTAMP.test(item.ts)) {
    throw new Error("invalid denial timestamp");
  }
  if (item.profile !== undefined && typeof item.profile !== "string") {
    throw new Error("invalid denial profile");
  }
  return item as unknown as DenialEvidenceV1;
}
