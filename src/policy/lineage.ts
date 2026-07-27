// pure: relative actor/box lineage facts retained by a trusted lifecycle owner.

export type LineageActorKind = "human" | "agent";
export type LineageHostPosition = "operator" | "parent-inhabitant";

export interface LineageActorV0 {
  readonly kind: LineageActorKind;
  readonly id: string;
}

export interface BoxLineageV0 {
  readonly version: 0;
  readonly box: string;
  readonly parent: string | null;
  readonly depth: number;
  readonly host: {
    readonly actor: LineageActorV0;
    readonly position: LineageHostPosition;
  };
}

function validIdentifier(value: string, label: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty identifier`);
  }
}

function validActor(actor: LineageActorV0): void {
  validIdentifier(actor.id, "lineage actor");
  if (actor.kind !== "human" && actor.kind !== "agent") {
    throw new TypeError("lineage actor kind must be human or agent");
  }
}

/** Create the trusted root observation. Actor kind is not authority; operator
 * position means this actor is outside the governed lineage. */
export function rootLineage(
  box: string,
  actor: LineageActorV0,
): BoxLineageV0 {
  validIdentifier(box, "lineage box");
  validActor(actor);
  return {
    version: 0,
    box,
    parent: null,
    depth: 0,
    host: { actor, position: "operator" },
  };
}

/** Add a child observation. The default journey is an agent that remains an
 * inhabitant of the parent while acting as host to this child. */
export function deriveChildLineage(
  parent: BoxLineageV0,
  box: string,
  actor: LineageActorV0,
  position: LineageHostPosition = "parent-inhabitant",
): BoxLineageV0 {
  validIdentifier(box, "lineage box");
  validActor(actor);
  if (box === parent.box) {
    throw new TypeError("child lineage box must be distinct from its parent");
  }
  if (position !== "operator" && position !== "parent-inhabitant") {
    throw new TypeError("invalid lineage host position");
  }
  return {
    version: 0,
    box,
    parent: parent.box,
    depth: parent.depth + 1,
    host: { actor, position },
  };
}
