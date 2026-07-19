// pure
import type { Entry } from "./schema.ts";

/** Matches a tilde-fenced `~~~pagu:<kind> attrs\n<body>\n~~~` block. The fence
 * is variable-length (≥3): the closing must match the opening length (`\1`), so
 * a body line of fewer tildes can't close the block. Kind may contain lowercase
 * letters and hyphens (e.g. "skill-invoke"). */
const BLOCK = /^(~{3,})pagu:([a-z-]+)(.*)\n([\s\S]*?)\n\1$/gm;

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
      case "request": {
        let detail: { need?: unknown; justification?: unknown } = {};
        try {
          detail = JSON.parse(body);
        } catch {
          // Malformed historical blocks remain readable as empty evidence.
        }
        entries.push({
          kind: "request",
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
          id: a.id ?? "",
          grant: a.grant === "-" || a.grant === undefined ? null : a.grant,
          session: a.session ?? "",
          policy: a.policy ?? "",
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
          grant: a.grant ?? "",
          session: a.session ?? "",
          reason: body,
        });
        break;
      case "policy-grant-spent":
        entries.push({
          kind: "policy-grant-spent",
          grant: a.grant ?? "",
          session: a.session ?? "",
        });
        break;
        // Unknown pagu kinds are skipped (forward-compatibility).
    }
  }
  return entries;
}
