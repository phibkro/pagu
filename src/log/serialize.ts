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
  return `pagu:${kind}${a ? " " + a : ""}`;
}

/** The longest run of consecutive `~` in a string (0 if none). */
function longestTildeRun(s: string): number {
  let max = 0, cur = 0;
  for (const ch of s) {
    cur = ch === "~" ? cur + 1 : 0;
    if (cur > max) max = cur;
  }
  return max;
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
    case "result": {
      const rAttrs: Record<string, string> = {
        script: e.script,
        exit: String(e.exit),
        "ran-with": e.ranWith.join(" "),
      };
      if (e.sandbox !== undefined) rAttrs.sandbox = e.sandbox;
      open = head("result", rAttrs);
      body = e.output;
      break;
    }
  }
  // Use a fence longer than any `~` run in the body, so a body line of tildes
  // (e.g. a markdown `~~~` fence in model output) can't be read as the close.
  const fence = "~".repeat(Math.max(3, longestTildeRun(body) + 1));
  return `${fence}${open}\n${body}\n${fence}`;
}

/** Serialize a whole log. Blocks separated by a blank line. */
export function serializeLog(entries: Entry[]): string {
  return entries.map(serializeEntry).join("\n\n") + "\n";
}
