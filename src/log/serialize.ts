// pure
import type { Entry } from "./schema.ts";

/** Render attrs as `k=v`, quoting values that contain whitespace. */
function attrs(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([k, v]) => (/\s/.test(v) ? `${k}="${v}"` : `${k}=${v}`))
    .join(" ");
}

function head(kind: string, pairs: Record<string, string>): string {
  const a = attrs(pairs);
  return `~~~pagu:${kind}${a ? " " + a : ""}`;
}

/** Serialize one entry to a tilde-fenced `pagu:<kind>` block. */
export function serializeEntry(e: Entry): string {
  let open: string;
  let body: string;
  switch (e.kind) {
    case "message":
      open = head("message", { role: e.role });
      body = e.text;
      break;
    case "observation":
      open = head("observation", { source: e.source });
      body = e.content;
      break;
    case "script":
      open = head("script", { id: e.id, lang: e.lang });
      body = e.body;
      break;
    case "skill-invoke":
      open = head("skill-invoke", { id: e.id, script: e.script });
      body = e.args ? e.args.join("\n") : "";
      break;
    case "command-invoke":
      open = head("command-invoke", { id: e.id, program: e.program });
      body = e.args.join("\n");
      break;
    case "perms":
      open = head("perms", { script: e.script });
      body = e.perms.join("\n");
      break;
    case "decision":
      open = head("decision", { script: e.script, verdict: e.verdict });
      body = e.rationale;
      break;
    case "result":
      open = head("result", {
        script: e.script,
        exit: String(e.exit),
        "ran-with": e.ranWith.join(" "),
      });
      body = e.output;
      break;
  }
  return `${open}\n${body}\n~~~`;
}

/** Serialize a whole log. Blocks separated by a blank line. */
export function serializeLog(entries: Entry[]): string {
  return entries.map(serializeEntry).join("\n\n") + "\n";
}
