// effects: thin pagu-box adapter from JSON/filesystem/process I/O to policy SDK.
import {
  type BwrapCompileContext,
  compilePolicy,
  explain,
  loadPolicy,
  PolicyCompileError,
  PolicyValidationError,
  UnsupportedPlatformError,
} from "./index.ts";

interface Options {
  readonly policyFile: string;
  readonly explainOnly: boolean;
  readonly bwrap?: string;
  readonly command: readonly string[];
}

function usageError(message: string): never {
  console.error(`pagu-box: ${message}`);
  Deno.exit(64);
}

function parseArgs(args: readonly string[]): Options {
  let policyFile: string | undefined;
  let explainOnly = false;
  let bwrap: string | undefined;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      index++;
      break;
    }
    if (arg === "--policy") {
      policyFile = args[++index] ?? usageError("--policy requires a file");
    } else if (arg === "--explain") {
      explainOnly = true;
    } else if (arg === "--bwrap") {
      bwrap = args[++index] ?? usageError("--bwrap requires an executable");
    } else {
      usageError(`internal policy adapter received unknown option '${arg}'`);
    }
  }
  if (!policyFile) usageError("--policy is required");
  const command = args.slice(index);
  if (explainOnly && command.length > 0) {
    usageError("--explain does not accept a command");
  }
  if (!explainOnly && command.length === 0) usageError("no command given");
  if (!explainOnly && !bwrap) usageError("internal --bwrap is required");
  return { policyFile, explainOnly, bwrap, command };
}

function pathKind(path: string): "directory" | "file" | "missing" {
  try {
    const info = Deno.statSync(path);
    return info.isDirectory ? "directory" : "file";
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "missing";
    throw error;
  }
}

function context(): BwrapCompileContext {
  const environment = Deno.env.toObject();
  const home = environment.HOME;
  if (!home) throw new PolicyCompileError("HOME is not set");
  const platform = Deno.build.os === "darwin" ? "darwin" : "linux";
  return {
    platform,
    home,
    pwd: Deno.cwd(),
    user: environment.USER ?? "unknown",
    path: environment.PATH ?? "",
    term: environment.TERM ?? "xterm",
    lang: environment.LANG ?? "C.UTF-8",
    sslCertFile: environment.SSL_CERT_FILE ??
      environment.NIX_SSL_CERT_FILE ??
      "/etc/ssl/certs/ca-certificates.crt",
    environment,
    pathKind,
    environmentMode: "process",
  };
}

async function main(): Promise<number> {
  const options = parseArgs(Deno.args);
  const source = await Deno.readTextFile(options.policyFile);
  const loaded = loadPolicy({ user: JSON.parse(source) });
  for (const warning of loaded.warnings) console.error(`pagu-box: ${warning}`);
  const ctx = context();
  if (options.explainOnly) {
    console.log(JSON.stringify(explain(loaded.policy, ctx)));
    return 0;
  }
  const compiled = compilePolicy(loaded.policy, ctx);
  const child = new Deno.Command(options.bwrap!, {
    args: [...compiled.argv, "--", ...options.command],
    clearEnv: true,
    env: { ...compiled.environment },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return (await child.status).code;
}

try {
  Deno.exit(await main());
} catch (error) {
  if (
    error instanceof PolicyValidationError ||
    error instanceof PolicyCompileError ||
    error instanceof UnsupportedPlatformError ||
    error instanceof SyntaxError ||
    error instanceof Deno.errors.NotFound ||
    error instanceof Deno.errors.PermissionDenied
  ) {
    console.error(`pagu-box: ${error.name}: ${error.message}`);
    Deno.exit(65);
  }
  throw error;
}
