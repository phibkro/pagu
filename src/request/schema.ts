// pure: strict schema for the sandbox-to-gate request channel.

export class RequestValidationError extends Error {
  override name = "RequestValidationError";

  constructor(message: string, readonly path = "request") {
    super(`${path}: ${message}`);
  }
}

export interface FileRequestInput {
  readonly need: string;
  readonly justification: string;
  readonly suggested_rule: { readonly "fs.ro": string };
}

export interface GateRequest extends FileRequestInput {
  readonly id: string;
}

export type DecisionScope = "once" | "session" | "persist";
export type GateTier = "refuse" | "auto" | "operator";

export type OperatorDecision =
  | { readonly verdict: "deny" }
  | { readonly verdict: "approve"; readonly scope: DecisionScope };

export interface GateDecision {
  readonly verdict: "approve" | "deny";
  readonly scope: DecisionScope | null;
  readonly tier: GateTier;
  readonly rationale: string;
  readonly granted_rule?: { readonly "fs.ro": string };
}

export interface RequestFrame {
  readonly version: 0;
  readonly kind: "request";
  readonly request: FileRequestInput;
}

type JsonObject = Record<string, unknown>;

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError("expected an object", path);
  }
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  required: readonly string[],
  path: string,
): void {
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new RequestValidationError(
        `unknown key ${JSON.stringify(key)}`,
        path,
      );
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new RequestValidationError(
        `missing required key ${JSON.stringify(key)}`,
        path,
      );
    }
  }
}

function nonemptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RequestValidationError("expected a non-empty string", path);
  }
  return value;
}

function capabilityPath(value: unknown, path: string): string {
  const candidate = nonemptyString(value, path);
  const rooted = candidate.startsWith("/") || candidate === "$PWD" ||
    candidate.startsWith("$PWD/") || candidate === "$HOME" ||
    candidate.startsWith("$HOME/") || candidate === "~" ||
    candidate.startsWith("~/");
  if (!rooted) {
    throw new RequestValidationError(
      "expected an absolute, $PWD, $HOME, or ~ path",
      path,
    );
  }
  if (
    candidate.split("/").includes("..") || candidate.includes("*") ||
    [...candidate].some((character) =>
      character === '"' || character.charCodeAt(0) < 0x20
    )
  ) {
    throw new RequestValidationError(
      "requested path must be exact and may not contain .., wildcards, quotes, or control characters",
      path,
    );
  }
  return candidate;
}

export function parseRequestInput(value: unknown): FileRequestInput {
  const request = objectAt(value, "request");
  exactKeys(request, ["need", "justification", "suggested_rule"], "request");
  const rule = objectAt(request.suggested_rule, "request.suggested_rule");
  exactKeys(rule, ["fs.ro"], "request.suggested_rule");
  return {
    need: nonemptyString(request.need, "request.need"),
    justification: nonemptyString(
      request.justification,
      "request.justification",
    ),
    suggested_rule: {
      "fs.ro": capabilityPath(rule["fs.ro"], "request.suggested_rule.fs.ro"),
    },
  };
}

export function parseRequestFrame(value: unknown): RequestFrame {
  const frame = objectAt(value, "frame");
  exactKeys(frame, ["version", "kind", "request"], "frame");
  if (frame.version !== 0) {
    throw new RequestValidationError("expected version 0", "frame.version");
  }
  if (frame.kind !== "request") {
    throw new RequestValidationError('expected kind "request"', "frame.kind");
  }
  return {
    version: 0,
    kind: "request",
    request: parseRequestInput(frame.request),
  };
}
