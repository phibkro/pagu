// effects: thin pagu-box adapter from JSON/filesystem/process I/O to policy SDK.
import {
  type BwrapCompileContext,
  compilePolicy,
  explain,
  isLexicallyCanonicalAbsolutePath,
  loadPolicy,
  PolicyCompileError,
  PolicyValidationError,
  UnsupportedPlatformError,
} from "./index.ts";

interface Options {
  readonly policyFile?: string;
  readonly policyJson?: string;
  readonly explainOnly: boolean;
  readonly bwrap?: string;
  readonly gate?: string;
  readonly evidence?: string;
  readonly evidenceStdio: boolean;
  readonly observeDenials?: string;
  readonly denialSupervisor?: string;
  readonly profileContext?: string;
  readonly supervisorPid?: number;
  readonly namespaceTarget?: number;
  readonly nsenter?: string;
  readonly command: readonly string[];
}

function usageError(message: string): never {
  console.error(`pagu-box: ${message}`);
  Deno.exit(64);
}

function parseArgs(args: readonly string[]): Options {
  let policyFile: string | undefined;
  let policyJson: string | undefined;
  let explainOnly = false;
  let bwrap: string | undefined;
  let gate: string | undefined;
  let evidence: string | undefined;
  let evidenceStdio = false;
  let observeDenials: string | undefined;
  let denialSupervisor: string | undefined;
  let profileContext: string | undefined;
  let supervisorPid: number | undefined;
  let namespaceTarget: number | undefined;
  let nsenter: string | undefined;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      index++;
      break;
    }
    if (arg === "--policy") {
      policyFile = args[++index] ?? usageError("--policy requires a file");
    } else if (arg === "--policy-json") {
      policyJson = args[++index] ??
        usageError("--policy-json requires JSON");
    } else if (arg === "--explain") {
      explainOnly = true;
    } else if (arg === "--bwrap") {
      bwrap = args[++index] ?? usageError("--bwrap requires an executable");
    } else if (arg === "--gate") {
      gate = args[++index] ?? usageError("--gate requires a socket");
    } else if (arg === "--evidence") {
      evidence = args[++index] ?? usageError("--evidence requires a file");
    } else if (arg === "--evidence-stdio") {
      evidenceStdio = true;
    } else if (arg === "--observe-denials") {
      observeDenials = args[++index] ??
        usageError("--observe-denials requires a file");
    } else if (arg === "--denial-supervisor") {
      denialSupervisor = args[++index] ??
        usageError("--denial-supervisor requires an executable");
    } else if (arg === "--profile-context") {
      profileContext = args[++index] ??
        usageError("--profile-context requires a name");
    } else if (arg === "--supervisor-pid") {
      const value = Number(
        args[++index] ?? usageError("--supervisor-pid requires a PID"),
      );
      if (!Number.isSafeInteger(value) || value <= 0) {
        usageError("--supervisor-pid requires a positive PID");
      }
      supervisorPid = value;
    } else if (arg === "--namespace-target") {
      const value = Number(
        args[++index] ??
          usageError("--namespace-target requires a PID"),
      );
      if (!Number.isSafeInteger(value) || value <= 0) {
        usageError("--namespace-target requires a positive PID");
      }
      namespaceTarget = value;
    } else if (arg === "--nsenter") {
      nsenter = args[++index] ??
        usageError("--nsenter requires an executable");
    } else {
      usageError(`internal policy adapter received unknown option '${arg}'`);
    }
  }
  if (policyFile && policyJson) {
    usageError("--policy and --policy-json are mutually exclusive");
  }
  if (!policyFile && !policyJson) {
    usageError("--policy or --policy-json is required");
  }
  const command = args.slice(index);
  if (explainOnly && command.length > 0) {
    usageError("--explain does not accept a command");
  }
  if (explainOnly && evidence) {
    usageError("--evidence cannot be combined with --explain");
  }
  if (explainOnly && evidenceStdio) {
    usageError("--evidence-stdio cannot be combined with --explain");
  }
  if (evidence && evidenceStdio) {
    usageError("--evidence and --evidence-stdio are mutually exclusive");
  }
  if (explainOnly && observeDenials) {
    usageError("--observe-denials cannot be combined with --explain");
  }
  if (observeDenials && !denialSupervisor) {
    usageError("internal --denial-supervisor is required for observation");
  }
  if ((namespaceTarget === undefined) !== (nsenter === undefined)) {
    usageError(
      "--namespace-target and --nsenter must be supplied together",
    );
  }
  if (explainOnly && namespaceTarget !== undefined) {
    usageError("--namespace-target cannot be combined with --explain");
  }
  if (!explainOnly && command.length === 0) usageError("no command given");
  if (!explainOnly && !bwrap) usageError("internal --bwrap is required");
  return {
    policyFile,
    policyJson,
    explainOnly,
    bwrap,
    gate,
    evidence,
    evidenceStdio,
    observeDenials,
    denialSupervisor,
    profileContext,
    supervisorPid,
    namespaceTarget,
    nsenter,
    command,
  };
}

function contains(parent: string, child: string): boolean {
  const root = parent.length > 1 ? parent.replace(/\/+$/, "") : parent;
  return child === root || child.startsWith(root === "/" ? "/" : `${root}/`);
}

function canonicalLogPath(path: string): string {
  if (!path.startsWith("/")) {
    throw new PolicyCompileError("denial log path must be absolute");
  }
  try {
    return Deno.realPathSync(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const slash = path.lastIndexOf("/");
    const parent = slash <= 0 ? "/" : path.slice(0, slash);
    const leaf = path.slice(slash + 1);
    if (!leaf) {
      throw new PolicyCompileError("denial log path names a directory");
    }
    return `${Deno.realPathSync(parent).replace(/\/$/, "")}/${leaf}`;
  }
}

function assertDenialLogBoundary(
  logPath: string,
  writablePaths: readonly string[],
): void {
  const target = canonicalLogPath(logPath);
  for (const path of writablePaths) {
    const root = Deno.realPathSync(path);
    if (contains(root, target)) {
      throw new PolicyCompileError(
        `denial log ${target} is inside sandbox-writable root ${root}`,
      );
    }
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function supervisorLost(pid: number): Promise<void> {
  while (Deno.ppid === pid) await delay(100);
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

function context(gate?: string): BwrapCompileContext {
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
    requestSocket: gate
      ? {
        hostPath: Deno.realPathSync(gate),
        sandboxPath: "/run/pagu/request.sock",
      }
      : undefined,
  };
}

async function main(): Promise<number> {
  const options = parseArgs(Deno.args);
  const source = options.policyJson ??
    await Deno.readTextFile(options.policyFile!);
  const loaded = loadPolicy({ user: JSON.parse(source) });
  for (const warning of loaded.warnings) console.error(`pagu-box: ${warning}`);
  const ctx = context(options.gate);
  if (options.explainOnly) {
    console.log(JSON.stringify(explain(loaded.policy, ctx)));
    return 0;
  }
  const compiled = compilePolicy(loaded.policy, ctx);
  if (options.observeDenials) {
    assertDenialLogBoundary(options.observeDenials, compiled.writablePaths);
    const ambiguous = compiled.denialRules.find((rule) =>
      !isLexicallyCanonicalAbsolutePath(rule.path)
    );
    if (ambiguous) {
      throw new PolicyCompileError(
        `denial observation requires lexically canonical fs.deny paths: ${ambiguous.path}`,
      );
    }
  }
  if (
    options.supervisorPid !== undefined && Deno.ppid !== options.supervisorPid
  ) {
    throw new PolicyCompileError("gate supervisor is not running");
  }
  const bwrapArgs = [...compiled.argv, "--", ...options.command];
  const sandboxExecutable = options.observeDenials
    ? options.denialSupervisor!
    : options.bwrap!;
  const sandboxArgs = options.observeDenials
    ? [
      "--log",
      options.observeDenials,
      ...compiled.denialRules.flatMap((rule) => [
        rule.match === "subtree" ? "--deny-tree" : "--deny-path",
        rule.path,
      ]),
      ...(options.profileContext ? ["--profile", options.profileContext] : []),
      "--",
      options.bwrap!,
      ...bwrapArgs,
    ]
    : bwrapArgs;
  const executable = options.nsenter ?? sandboxExecutable;
  const args = options.nsenter
    ? [
      "--target",
      String(options.namespaceTarget),
      "--user",
      "--preserve-credentials",
      "--mount",
      "--net",
      "--ipc",
      "--uts",
      "--pid",
      `--wdns=${ctx.pwd}`,
      "--",
      sandboxExecutable,
      ...sandboxArgs,
    ]
    : sandboxArgs;
  const child = new Deno.Command(executable, {
    args,
    clearEnv: true,
    env: { ...compiled.environment },
    stdin: "inherit",
    stdout: "inherit",
    // In streamed-evidence mode the adapter must write the trusted prefix
    // before an untrusted child can emit a lookalike line.
    stderr: options.evidenceStdio ? "piped" : "inherit",
  }).spawn();
  const status = child.status;
  let stopPromise: Promise<void> | undefined;
  const stopEnforcement = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      try {
        child.kill("SIGTERM");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      const stopped = await Promise.race([
        status.then(() => true),
        delay(2_000).then(() => false),
      ]);
      if (!stopped) {
        try {
          child.kill("SIGKILL");
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        await status;
      }
    })();
    return stopPromise;
  };
  try {
    const launchEvidence = {
      version: 1,
      platform: "linux",
      cwd: ctx.pwd,
      pid: child.pid,
      argv: [...compiled.argv],
      environment: Object.keys(compiled.environment),
      command: [...options.command],
    };
    if (options.evidence) {
      await Deno.writeTextFile(
        options.evidence,
        JSON.stringify(launchEvidence) + "\n",
        { createNew: true, mode: 0o600 },
      );
    }
    if (options.evidenceStdio) {
      console.error(
        `PAGU_LAUNCH_EVIDENCE_V1=${JSON.stringify(launchEvidence)}`,
      );
    }
    const stderrForward = options.evidenceStdio
      ? child.stderr.pipeTo(Deno.stderr.writable, { preventClose: true })
      : Promise.resolve();
    if (options.supervisorPid !== undefined) {
      const result = await Promise.race([
        status.then((value) => ({ kind: "child" as const, value })),
        supervisorLost(options.supervisorPid).then(
          () => ({ kind: "supervisor" as const }),
        ),
      ]);
      if (result.kind === "supervisor") {
        console.error("pagu-box: gate supervisor exited; stopping sandbox");
        await stopEnforcement();
        await stderrForward;
        return 70;
      }
      await stderrForward;
      return result.value.code;
    }
    const result = await status;
    await stderrForward;
    return result.code;
  } catch (error) {
    await stopEnforcement();
    throw error;
  }
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
