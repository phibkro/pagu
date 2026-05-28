// effects: handler phase — runs a user handler in an isolated subprocess.
// Lightweight raw JSON I/O (not the respond-phase Entry[] protocol).
// stdin:  HandlerPhaseInput  { handlerPath, exec: ExecView }
// stdout: HandlerPhaseOutput { decision: "continue"|"done", rationale? }
import type {
  ExecView,
  HandlerPhaseInput,
  HandlerPhaseOutput,
} from "../capability/index.ts";
import type { ReadonlyExec } from "../capability/index.ts";

const chunks: Uint8Array[] = [];
for await (const chunk of Deno.stdin.readable) {
  chunks.push(chunk);
}
const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
let offset = 0;
for (const c of chunks) {
  total.set(c, offset);
  offset += c.length;
}
const { handlerPath, exec } = JSON.parse(
  new TextDecoder().decode(total),
) as HandlerPhaseInput;

const mod = await import(handlerPath);

// Minimal ReadonlyExec adapter from ExecView — ctx is unavailable in subprocess.
const view = exec as ExecView;
const pseudoExec: ReadonlyExec = {
  ctx: undefined as never,
  id: view.id,
  title: view.title,
  body: view.body,
  perms: view.perms,
  rationale: "",
  outcome: "loop",
};

const decision: "continue" | "done" = await mod.default(pseudoExec);
const output: HandlerPhaseOutput = { decision };
console.log(JSON.stringify(output));
