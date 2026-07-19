// effects: outside-sandbox operator CLI for the request gate.
import {
  createGate,
  type GateApprover,
  type GatePaths,
  serveGate,
} from "../request/index.ts";

interface Options {
  readonly policy: string;
  readonly socket: string;
  readonly stateDir: string;
}

function usage(message?: string): never {
  if (message) console.error(`pagu: ${message}`);
  console.error(
    "usage: pagu gate --policy FILE [--socket PATH] [--state-dir DIR]",
  );
  Deno.exit(message ? 64 : 0);
}

function parseArgs(args: readonly string[]): Options {
  if (args[0] !== "gate") usage("expected the 'gate' command");
  let policy: string | undefined;
  let socket: string | undefined;
  let stateDir = ".pagu/gate";
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--policy") policy = args[++index];
    else if (arg === "--socket") socket = args[++index];
    else if (arg === "--state-dir") stateDir = args[++index] ?? "";
    else if (arg === "-h" || arg === "--help") usage();
    else usage(`unknown option ${JSON.stringify(arg)}`);
  }
  if (!policy) usage("--policy requires a file");
  if (!stateDir) usage("--state-dir requires a directory");
  return { policy, socket: socket ?? `${stateDir}/request.sock`, stateDir };
}

const ttyApprover: GateApprover = (request) => {
  console.error(`\nFile request ${request.id}`);
  console.error(`Need: ${request.need}`);
  console.error(`Why:  ${request.justification}`);
  console.error(`Rule: fs.ro=${request.suggested_rule["fs.ro"]}`);
  const answer = prompt("Deny, approve [o]nce, [s]ession, or [p]ersist? [d] ")
    ?.trim().toLowerCase();
  if (answer === "o" || answer === "once") {
    return Promise.resolve({ verdict: "approve", scope: "once" });
  }
  if (answer === "s" || answer === "session") {
    return Promise.resolve({ verdict: "approve", scope: "session" });
  }
  if (answer === "p" || answer === "persist") {
    return Promise.resolve({ verdict: "approve", scope: "persist" });
  }
  return Promise.resolve({ verdict: "deny" });
};

export async function main(args = Deno.args): Promise<void> {
  const options = parseArgs(args);
  const paths: GatePaths = {
    eventLog: `${options.stateDir}/events.md`,
    sessionGrants: `${options.stateDir}/session-grants.json`,
    queue: `${options.stateDir}/queue.json`,
    userPolicy: options.policy,
  };
  const gate = await createGate({ paths, approver: ttyApprover });
  const server = await serveGate({ socket: options.socket, gate });
  console.error(`pagu gate: listening on ${options.socket}`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    Deno.addSignalListener("SIGINT", stop);
    Deno.addSignalListener("SIGTERM", stop);
  });
  await server.close();
  gate.events.close();
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`pagu: ${error instanceof Error ? error.message : error}`);
    Deno.exit(1);
  }
}
