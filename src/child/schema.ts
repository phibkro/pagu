// pure: strict inhabitant-to-child-broker launch frame.
import {
  parsePolicy,
  type PolicyV0,
  PolicyValidationError,
} from "../policy/index.ts";
import type { LineageActorV0 } from "../policy/lineage.ts";

export class ChildBrokerValidationError extends Error {
  override name = "ChildBrokerValidationError";

  constructor(message: string, readonly path = "child-launch") {
    super(`${path}: ${message}`);
  }
}

export interface ChildLaunchFrameV0 {
  readonly version: 0;
  readonly kind: "launch-child";
  /** Display identity only. Peer credentials and namespaces select authority. */
  readonly host: LineageActorV0;
  readonly policy: PolicyV0;
  readonly command: readonly string[];
}

type JsonObject = Record<string, unknown>;

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChildBrokerValidationError("expected an object", path);
  }
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  expected: readonly string[],
  path: string,
): void {
  const keys = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new ChildBrokerValidationError(
        `unknown key ${JSON.stringify(key)}`,
        path,
      );
    }
  }
  for (const key of expected) {
    if (!(key in value)) {
      throw new ChildBrokerValidationError(
        `missing required key ${JSON.stringify(key)}`,
        path,
      );
    }
  }
}

function nonemptyString(value: unknown, path: string): string {
  if (
    typeof value !== "string" || value.trim() === "" || value.includes("\0")
  ) {
    throw new ChildBrokerValidationError(
      "expected a non-empty string without NUL",
      path,
    );
  }
  return value;
}

function actorAt(value: unknown): LineageActorV0 {
  const actor = objectAt(value, "child-launch.host");
  exactKeys(actor, ["kind", "id"], "child-launch.host");
  if (actor.kind !== "human" && actor.kind !== "agent") {
    throw new ChildBrokerValidationError(
      'expected "human" or "agent"',
      "child-launch.host.kind",
    );
  }
  return {
    kind: actor.kind,
    id: nonemptyString(actor.id, "child-launch.host.id"),
  };
}

function commandAt(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ChildBrokerValidationError(
      "expected a non-empty command array",
      "child-launch.command",
    );
  }
  if (value.length > 256) {
    throw new ChildBrokerValidationError(
      "command exceeds 256 arguments",
      "child-launch.command",
    );
  }
  const command = value.map((item, index) => {
    if (typeof item !== "string" || item.includes("\0")) {
      throw new ChildBrokerValidationError(
        "expected a string without NUL",
        `child-launch.command[${index}]`,
      );
    }
    return item;
  });
  if (command[0].trim() === "") {
    throw new ChildBrokerValidationError(
      "executable must be non-empty",
      "child-launch.command[0]",
    );
  }
  if (command.reduce((size, item) => size + item.length, 0) > 64 * 1024) {
    throw new ChildBrokerValidationError(
      "command exceeds 64 KiB",
      "child-launch.command",
    );
  }
  return command;
}

/** Decode the only inhabitant-facing child-host operation. */
export function parseChildLaunchFrame(value: unknown): ChildLaunchFrameV0 {
  const frame = objectAt(value, "child-launch");
  exactKeys(
    frame,
    ["version", "kind", "host", "policy", "command"],
    "child-launch",
  );
  if (frame.version !== 0) {
    throw new ChildBrokerValidationError(
      "expected version 0",
      "child-launch.version",
    );
  }
  if (frame.kind !== "launch-child") {
    throw new ChildBrokerValidationError(
      'expected "launch-child"',
      "child-launch.kind",
    );
  }
  let policy: PolicyV0;
  try {
    policy = parsePolicy(frame.policy);
  } catch (error) {
    if (!(error instanceof PolicyValidationError)) throw error;
    throw new ChildBrokerValidationError(error.message, "child-launch.policy");
  }
  return {
    version: 0,
    kind: "launch-child",
    host: actorAt(frame.host),
    policy,
    command: commandAt(frame.command),
  };
}
