// pure
import type { Entry } from "./schema.ts";

/** Matches a tilde-fenced `~~~pagu:<kind> attrs\n<body>\n~~~` block. The fence
 * is variable-length (≥3): the closing must match the opening length (`\1`), so
 * a body line of fewer tildes can't close the block. Kind may contain lowercase
 * letters and hyphens (e.g. "skill-invoke"). */
const BLOCK = /^(~{3,})pagu:([a-z-]+)(.*)\n([\s\S]*?)\n\1$/gm;

type JsonObject = Record<string, unknown>;

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

/** Parse `k=v` / `k="quoted v"` attrs from a block's opening line. */
function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\S+?)=("([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out[m[1]] = m[3] !== undefined ? m[3] : m[4];
  }
  return out;
}

/** Parse a log's markdown into Entries. Non-`pagu:` prose is ignored. */
export function parseLog(md: string): Entry[] {
  const entries: Entry[] = [];
  BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK.exec(md)) !== null) {
    const kind = m[2];
    const a = parseAttrs(m[3]);
    const body = m[4];
    switch (kind) {
      case "message":
        entries.push({
          kind,
          role: a.role === "assistant" ? "assistant" : "user",
          text: body,
        });
        break;
      case "observation":
        entries.push({ kind, source: a.source ?? "", content: body });
        break;
      case "script":
        entries.push({ kind, id: a.id ?? "", lang: a.lang ?? "ts", body });
        break;
      case "command-invoke":
        entries.push({
          kind: "command-invoke",
          id: a.id ?? "",
          program: a.program ?? "",
          args: body ? body.split("\n") : [],
        });
        break;
      case "skill-invoke": {
        const inv: import("./schema.ts").SkillInvocationEntry = {
          kind: "skill-invoke",
          id: a.id ?? "",
          script: a.script ?? "",
        };
        if (body) inv.args = body.split("\n");
        entries.push(inv);
        break;
      }
      case "perms":
        entries.push({
          kind,
          script: a.script ?? "",
          perms: body ? body.split("\n") : [],
        });
        break;
      case "grant":
        entries.push({
          kind: "grant",
          id: a.id ?? "",
          perms: body ? body.split("\n") : [],
          expires: a.expires ?? "",
        });
        break;
      case "revoke":
        entries.push({ kind: "revoke", grant: a.grant ?? "" });
        break;
      case "decision":
        entries.push({
          kind,
          script: a.script ?? "",
          verdict: a.verdict === "approve"
            ? "approve"
            : a.verdict === "expired"
            ? "expired"
            : "reject",
          rationale: body,
        });
        break;
      case "result": {
        const re: import("./schema.ts").ResultEntry = {
          kind,
          script: a.script ?? "",
          exit: Number(a.exit ?? "0"),
          ranWith: a["ran-with"] ? a["ran-with"].split(" ") : [],
          output: body,
        };
        if (
          a.sandbox === "bwrap" || a.sandbox === "sandbox-exec" ||
          a.sandbox === "none"
        ) {
          re.sandbox = a.sandbox;
        }
        entries.push(re);
        break;
      }
      case "gate-session": {
        // Silently continuing would attribute following unversioned request
        // events to the previous session. An old reader must fail loud.
        if (a.version !== "0" && a.version !== "1" && a.version !== "2") {
          throw new Error(
            `unsupported gate-session version ${a.version ?? "missing"}`,
          );
        }
        let metadata: {
          at?: unknown;
          session?: unknown;
          profile?: unknown;
          subjectAgent?: unknown;
          subjectLabel?: unknown;
          harness?: unknown;
          initial?: unknown;
        };
        try {
          metadata = JSON.parse(body);
        } catch {
          throw new Error("malformed gate-session metadata");
        }
        const expected = a.version === "0"
          ? ["at", "profile", "session", "subjectAgent", "subjectLabel"]
          : a.version === "1"
          ? [
            "at",
            "harness",
            "profile",
            "session",
            "subjectAgent",
            "subjectLabel",
          ]
          : [
            "at",
            "harness",
            "initial",
            "profile",
            "session",
            "subjectAgent",
            "subjectLabel",
          ];
        const actual = metadata && typeof metadata === "object"
          ? Object.keys(metadata).sort()
          : [];
        if (
          !metadata || typeof metadata !== "object" ||
          actual.length !== expected.length ||
          actual.some((key, index) => key !== expected[index]) ||
          typeof metadata.at !== "string" ||
          typeof metadata.session !== "string" ||
          (metadata.profile !== null &&
            typeof metadata.profile !== "string") ||
          typeof metadata.subjectAgent !== "string" ||
          typeof metadata.subjectLabel !== "string" ||
          (a.version !== "0" && typeof metadata.harness !== "string") ||
          (a.version === "2" && metadata.initial !== "fresh")
        ) throw new Error("malformed gate-session metadata");
        const base = {
          kind: "gate-session",
          at: metadata.at,
          session: metadata.session,
          profile: metadata.profile,
          subjectAgent: metadata.subjectAgent,
          subjectLabel: metadata.subjectLabel,
        } as const;
        entries.push(
          a.version === "0"
            ? { ...base, version: 0 }
            : a.version === "1"
            ? { ...base, version: 1, harness: metadata.harness as string }
            : {
              ...base,
              version: 2,
              harness: metadata.harness as string,
              initial: "fresh",
            },
        );
        break;
      }
      case "request": {
        let detail: { need?: unknown; justification?: unknown } = {};
        try {
          detail = JSON.parse(body);
        } catch {
          // Malformed historical blocks remain readable as empty evidence.
        }
        entries.push({
          kind: "request",
          ...(a.at ? { at: a.at } : {}),
          id: a.id ?? "",
          need: typeof detail.need === "string" ? detail.need : "",
          justification: typeof detail.justification === "string"
            ? detail.justification
            : "",
          fsRo: a["fs-ro"] ?? "",
        });
        break;
      }
      case "request-decision": {
        const scope = a.scope === "once" || a.scope === "session" ||
            a.scope === "persist"
          ? a.scope
          : null;
        entries.push({
          kind: "request-decision",
          ...(a.at ? { at: a.at } : {}),
          request: a.request ?? "",
          verdict: a.verdict === "approve" ? "approve" : "deny",
          scope,
          tier: a.tier === "refuse" || a.tier === "auto" ? a.tier : "operator",
          rationale: body,
        });
        break;
      }
      case "policy-grant":
        entries.push({
          kind: "policy-grant",
          ...(a.at ? { at: a.at } : {}),
          id: a.id ?? "",
          request: a.request ?? "",
          scope: a.scope === "once" || a.scope === "persist"
            ? a.scope
            : "session",
          fsRo: a["fs-ro"] ?? "",
          canonicalFsRo: a["canonical-fs-ro"] ?? a["fs-ro"] ?? "",
          session: a.session ?? "",
          authority: a.authority ?? "",
          policy: a.policy ?? "",
        });
        break;
      case "policy-launch": {
        let detail: {
          cwd?: unknown;
          resume?: unknown;
          argv?: unknown;
          environment?: unknown;
        } = {};
        try {
          detail = JSON.parse(body);
        } catch {
          // Malformed evidence fails closed to empty display fields.
        }
        const strings = (value: unknown): string[] =>
          Array.isArray(value) &&
            value.every((item) => typeof item === "string")
            ? value
            : [];
        entries.push({
          kind: "policy-launch",
          ...(a.at ? { at: a.at } : {}),
          id: a.id ?? "",
          grant: a.grant === undefined ? null : a.grant,
          session: a.session ?? "",
          policy: a.policy ?? "",
          cwd: typeof detail.cwd === "string" ? detail.cwd : "",
          pid: Number(a.pid ?? "0"),
          resume: strings(detail.resume),
          argv: strings(detail.argv),
          environment: strings(detail.environment),
        });
        break;
      }
      case "policy-launch-failed":
        entries.push({
          kind: "policy-launch-failed",
          ...(a.at ? { at: a.at } : {}),
          grant: a.grant ?? "",
          session: a.session ?? "",
          reason: body,
        });
        break;
      case "policy-grant-spent":
        entries.push({
          kind: "policy-grant-spent",
          ...(a.at ? { at: a.at } : {}),
          grant: a.grant ?? "",
          session: a.session ?? "",
        });
        break;
      case "child-launch": {
        if (a.version !== "0") {
          throw new Error(
            `unsupported child-launch version ${a.version ?? "missing"}`,
          );
        }
        const attrKeys = Object.keys(a).sort();
        const expectedAttrs = a.at === undefined
          ? ["version"]
          : ["at", "version"];
        if (
          attrKeys.length !== expectedAttrs.length ||
          attrKeys.some((key, index) => key !== expectedAttrs[index])
        ) throw new Error("malformed child-launch evidence");
        let detail: unknown;
        try {
          detail = JSON.parse(body);
        } catch {
          throw new Error("malformed child-launch evidence");
        }
        const keys = [
          "id",
          "parent",
          "depth",
          "host",
          "parentPolicy",
          "policy",
          "requestRoute",
          "pid",
          "namespace",
          "cwd",
          "command",
          "argv",
          "environment",
        ];
        if (!exactObject(detail, keys)) {
          throw new Error("malformed child-launch evidence");
        }
        const host = detail.host;
        const namespace = detail.namespace;
        if (
          !exactObject(host, ["actor", "position"]) ||
          !exactObject(host.actor, ["kind", "id"]) ||
          (host.actor.kind !== "human" && host.actor.kind !== "agent") ||
          typeof host.actor.id !== "string" ||
          host.position !== "parent-inhabitant" ||
          !exactObject(namespace, [
            "version",
            "user",
            "mount",
            "pid",
            "network",
            "ipc",
            "uts",
          ]) ||
          namespace.version !== 0 ||
          ["user", "mount", "pid", "network", "ipc", "uts"].some((key) =>
            typeof namespace[key] !== "string"
          ) ||
          typeof detail.id !== "string" ||
          typeof detail.parent !== "string" ||
          !Number.isSafeInteger(detail.depth) ||
          (detail.depth as number) < 1 ||
          typeof detail.parentPolicy !== "string" ||
          typeof detail.policy !== "string" ||
          typeof detail.requestRoute !== "string" ||
          !Number.isSafeInteger(detail.pid) ||
          (detail.pid as number) <= 0 ||
          typeof detail.cwd !== "string" ||
          !stringArray(detail.command) ||
          !stringArray(detail.argv) ||
          !stringArray(detail.environment)
        ) throw new Error("malformed child-launch evidence");
        entries.push({
          kind: "child-launch",
          version: 0,
          ...(a.at ? { at: a.at } : {}),
          id: detail.id,
          parent: detail.parent,
          depth: detail.depth as number,
          host: {
            actor: {
              kind: host.actor.kind,
              id: host.actor.id,
            },
            position: "parent-inhabitant",
          },
          parentPolicy: detail.parentPolicy,
          policy: detail.policy,
          requestRoute: detail.requestRoute,
          pid: detail.pid as number,
          namespace: {
            version: 0,
            user: namespace.user as string,
            mount: namespace.mount as string,
            pid: namespace.pid as string,
            network: namespace.network as string,
            ipc: namespace.ipc as string,
            uts: namespace.uts as string,
          },
          cwd: detail.cwd,
          command: detail.command,
          argv: detail.argv,
          environment: detail.environment,
        });
        break;
      }
        // Unknown pagu kinds are skipped (forward-compatibility).
    }
  }
  return entries;
}
