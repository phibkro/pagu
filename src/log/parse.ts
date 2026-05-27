// pure
import type { Entry } from "./schema.ts";

/** Matches a tilde-fenced `~~~pagu:<kind> attrs\n<body>\n~~~` block.
 * Kind may contain lowercase letters and hyphens (e.g. "skill-invoke"). */
const BLOCK = /^~~~pagu:([a-z-]+)(.*)\n([\s\S]*?)\n~~~$/gm;

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
    const kind = m[1];
    const a = parseAttrs(m[2]);
    const body = m[3];
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
      case "decision":
        entries.push({
          kind,
          script: a.script ?? "",
          verdict: a.verdict === "approve" ? "approve" : "reject",
          rationale: body,
        });
        break;
      case "result":
        entries.push({
          kind,
          script: a.script ?? "",
          exit: Number(a.exit ?? "0"),
          ranWith: a["ran-with"] ? a["ran-with"].split(" ") : [],
          output: body,
        });
        break;
        // Unknown pagu kinds are skipped (forward-compatibility).
    }
  }
  return entries;
}
