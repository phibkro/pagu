// effects: credential/namespace-aware child derivation and launch transaction.
import {
  type BoxLineageV0,
  deriveChildLineage,
  deriveChildPolicy,
  parsePolicy,
  policyIdentity,
  type PolicyV0,
} from "../policy/index.ts";
import { type ChildLaunchFrameV0, parseChildLaunchFrame } from "./schema.ts";

export interface SenderObservationV0 {
  readonly version: 0;
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
  readonly namespace: BoxNamespaceV0;
}

/** Kernel namespace identities as observed outside the governed box. */
export interface BoxNamespaceV0 {
  readonly version: 0;
  readonly user: string;
  readonly mount: string;
  readonly pid: string;
  readonly network: string;
  readonly ipc: string;
  readonly uts: string;
}

export type NamespaceRelationship =
  | "same"
  | "different"
  | "descendant"
  | "unrelated";

export interface BoxNamespaceRelationV0 {
  readonly user: NamespaceRelationship;
  readonly mount: NamespaceRelationship;
  readonly pid: NamespaceRelationship;
  readonly network: NamespaceRelationship;
  readonly ipc: NamespaceRelationship;
  readonly uts: NamespaceRelationship;
}

export interface BrokerBoxV0 {
  readonly lineage: BoxLineageV0;
  readonly policy: PolicyV0;
  readonly namespace: BoxNamespaceV0;
  readonly requestRoute: string;
  readonly cwd: string;
}

export interface BrokerChildLineageV0 extends Omit<BoxLineageV0, "host"> {
  readonly host: {
    readonly actor: ChildLaunchFrameV0["host"];
    readonly position: "parent-inhabitant";
  };
}

export interface ChildLaunchEvidenceV0 {
  readonly version: 0;
  readonly id: string;
  readonly parent: string;
  readonly depth: number;
  readonly host: BrokerChildLineageV0["host"];
  readonly parentPolicy: string;
  readonly policy: string;
  readonly requestRoute: string;
  readonly pid: number;
  readonly namespace: BoxNamespaceV0;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly argv: readonly string[];
  readonly environment: readonly string[];
}

export interface RunningBrokerChild {
  stop(): Promise<void>;
}

export interface PreparedChildLaunch {
  readonly parent: BrokerBoxV0;
  readonly child: BrokerChildLineageV0;
  readonly policy: PolicyV0;
  readonly parentPolicy: string;
  readonly policyIdentity: string;
  readonly requestRoute: string;
  readonly command: readonly string[];
}

export interface StartedChildLaunch {
  readonly running: RunningBrokerChild;
  readonly evidence: ChildLaunchEvidenceV0;
}

export interface ChildBrokerPorts {
  /** Resolve paths as seen from the exact parent namespace. */
  readonly canonicalize: (parent: BrokerBoxV0, path: string) => string | null;
  /** Trusted Linux adapter describes the observed kernel relationship. */
  readonly namespaceRelation: (
    parent: BoxNamespaceV0,
    child: BoxNamespaceV0,
  ) => Promise<BoxNamespaceRelationV0>;
  readonly nextId: () => string;
  readonly launch: (input: PreparedChildLaunch) => Promise<StartedChildLaunch>;
  /** Append to the outside-owned canonical event store. */
  readonly append: (evidence: ChildLaunchEvidenceV0) => Promise<void>;
}

export interface ChildBrokerOptions {
  readonly root: BrokerBoxV0;
  readonly ports: ChildBrokerPorts;
}

export interface ChildLaunchResultV0 {
  readonly version: 0;
  readonly id: string;
  readonly parent: string;
  readonly depth: number;
  readonly policy: string;
  readonly requestRoute: string;
  readonly pid: number;
}

export interface ChildBroker {
  launch(
    sender: SenderObservationV0,
    frame: unknown,
  ): Promise<ChildLaunchResultV0>;
  /** Trusted lifecycle shutdown; retries any child retained after rollback. */
  close(): Promise<void>;
}

function namespaceKey(namespace: BoxNamespaceV0): string {
  return [
    namespace.user,
    namespace.mount,
    namespace.pid,
    namespace.network,
    namespace.ipc,
    namespace.uts,
  ].join("\0");
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function equalHost(
  left: BoxLineageV0["host"],
  right: BoxLineageV0["host"],
): boolean {
  return left.position === right.position &&
    left.actor.kind === right.actor.kind &&
    left.actor.id === right.actor.id;
}

function assertEvidence(
  evidence: ChildLaunchEvidenceV0,
  prepared: PreparedChildLaunch,
): void {
  const mismatch = evidence.version !== 0
    ? "version"
    : evidence.id !== prepared.child.box
    ? "id"
    : evidence.parent !== prepared.parent.lineage.box
    ? "parent"
    : evidence.depth !== prepared.child.depth
    ? "depth"
    : !equalHost(evidence.host, prepared.child.host)
    ? "host"
    : evidence.parentPolicy !== prepared.parentPolicy
    ? "parentPolicy"
    : evidence.policy !== prepared.policyIdentity
    ? "policy"
    : evidence.requestRoute !== prepared.requestRoute
    ? "requestRoute"
    : evidence.cwd !== prepared.parent.cwd
    ? "cwd"
    : !equalStrings(evidence.command, prepared.command)
    ? "command"
    : !Number.isSafeInteger(evidence.pid) || evidence.pid <= 0
    ? "pid"
    : undefined;
  if (mismatch) {
    throw new Error(
      `child launch evidence does not match prepared launch: ${mismatch}`,
    );
  }
}

function assertRelation(
  relation: BoxNamespaceRelationV0,
  policy: PolicyV0,
): void {
  for (const kind of ["user", "mount", "pid"] as const) {
    if (relation[kind] !== "descendant") {
      throw new Error(`${kind} namespace is not a descendant`);
    }
  }
  for (const kind of ["ipc", "uts"] as const) {
    if (relation[kind] === "same") {
      throw new Error(`${kind} namespace did not isolate`);
    }
    if (relation[kind] === "unrelated") {
      throw new Error(`${kind} namespace is unrelated`);
    }
  }
  // Both non-`off` modes inherit the parent's network namespace; they differ in
  // what may leave it, which is the gateway's concern and not observable here.
  if (policy.net.mode !== "off" && relation.network !== "same") {
    throw new Error("network namespace did not share parent");
  }
  if (policy.net.mode === "off" && relation.network !== "different") {
    throw new Error("network namespace did not isolate");
  }
}

/** Transactional child-host core. Caller authority comes only from the trusted
 * per-message sender namespace; the frame has no parent or operator action. */
export function createChildBroker(options: ChildBrokerOptions): ChildBroker {
  const root: BrokerBoxV0 = {
    ...options.root,
    policy: parsePolicy(options.root.policy),
  };
  const active = new Map<string, BrokerBoxV0>([
    [namespaceKey(root.namespace), root],
  ]);
  const ids = new Set<string>([root.lineage.box]);
  const pendingNamespaces = new Set<string>();
  const running = new Map<string, RunningBrokerChild>();
  let closed = false;
  let inFlight = 0;
  const idleWaiters: Array<() => void> = [];

  const launch = async (
    sender: SenderObservationV0,
    input: unknown,
  ): Promise<ChildLaunchResultV0> => {
    const frame: ChildLaunchFrameV0 = parseChildLaunchFrame(input);
    const parent = active.get(namespaceKey(sender.namespace));
    if (!parent) {
      throw new Error("sender namespace is not an active box");
    }

    const policy = deriveChildPolicy(parent.policy, frame.policy, {
      canonicalize: (path) => options.ports.canonicalize(parent, path),
    });
    const id = options.ports.nextId();
    if (ids.has(id)) throw new Error(`child box id already exists: ${id}`);
    ids.add(id);
    let started: StartedChildLaunch | undefined;
    try {
      const derived = deriveChildLineage(parent.lineage, id, frame.host);
      const child: BrokerChildLineageV0 = {
        ...derived,
        host: {
          actor: frame.host,
          position: "parent-inhabitant",
        },
      };
      const requestRoute = `request:${id}`;
      const [parentPolicy, childPolicyIdentity] = await Promise.all([
        policyIdentity(parent.policy),
        policyIdentity(policy),
      ]);
      const prepared: PreparedChildLaunch = {
        parent,
        child,
        policy,
        parentPolicy,
        policyIdentity: childPolicyIdentity,
        requestRoute,
        command: frame.command,
      };

      started = await options.ports.launch(prepared);
      running.set(id, started.running);
      assertEvidence(started.evidence, prepared);
      const relation = await options.ports.namespaceRelation(
        parent.namespace,
        started.evidence.namespace,
      );
      assertRelation(relation, policy);
      const childKey = namespaceKey(started.evidence.namespace);
      if (active.has(childKey) || pendingNamespaces.has(childKey)) {
        throw new Error("child namespace is already active");
      }
      pendingNamespaces.add(childKey);
      try {
        await options.ports.append(started.evidence);
        const childBox: BrokerBoxV0 = {
          lineage: child,
          policy,
          namespace: started.evidence.namespace,
          requestRoute,
          cwd: started.evidence.cwd,
        };
        active.set(childKey, childBox);
      } finally {
        pendingNamespaces.delete(childKey);
      }

      return {
        version: 0,
        id,
        parent: parent.lineage.box,
        depth: child.depth,
        policy: childPolicyIdentity,
        requestRoute,
        pid: started.evidence.pid,
      };
    } catch (error) {
      if (started) {
        try {
          await started.running.stop();
          running.delete(id);
        } catch (stopError) {
          throw new AggregateError(
            [error, stopError],
            `child launch failed and provisional box ${id} could not stop`,
          );
        }
      }
      ids.delete(id);
      throw error;
    }
  };

  return {
    async launch(sender, input) {
      if (closed) throw new Error("child broker is closed");
      inFlight++;
      try {
        return await launch(sender, input);
      } finally {
        inFlight--;
        if (inFlight === 0) {
          for (const resolve of idleWaiters.splice(0)) resolve();
        }
      }
    },
    async close() {
      closed = true;
      if (inFlight > 0) {
        await new Promise<void>((resolve) => idleWaiters.push(resolve));
      }
      const failures: unknown[] = [];
      for (const [id, child] of [...running]) {
        try {
          await child.stop();
          running.delete(id);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "one or more broker-owned children could not stop",
        );
      }
    },
  };
}
