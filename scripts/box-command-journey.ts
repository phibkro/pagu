#!/usr/bin/env -S deno run -A
// effects: compare the two packaged names for direct box operation.

export interface CommandObservation {
  readonly success: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BoxSurfaceCase {
  readonly name: string;
  readonly pagu: CommandObservation;
  readonly compatibility: CommandObservation;
}

function requireClaim(claim: unknown, message: string): asserts claim {
  if (!claim) throw new Error(`box command journey falsified: ${message}`);
}

/** The product subcommand and compatibility executable must be observationally
 * identical for the same box argv and trusted launch environment. */
export function assertBoxSurfacesEquivalent(
  cases: readonly BoxSurfaceCase[],
): void {
  requireClaim(cases.length > 0, "no comparison cases were supplied");
  for (const item of cases) {
    requireClaim(item.pagu.success, `${item.name} did not succeed`);
    requireClaim(
      item.pagu.success === item.compatibility.success,
      `${item.name} success status differs`,
    );
    requireClaim(
      item.pagu.code === item.compatibility.code,
      `${item.name} exit code differs`,
    );
    requireClaim(
      item.pagu.stdout === item.compatibility.stdout,
      `${item.name} stdout differs`,
    );
    requireClaim(
      item.pagu.stderr === item.compatibility.stderr,
      `${item.name} stderr differs`,
    );
  }
}

function usage(message?: string): never {
  if (message) console.error(`box-command-journey: ${message}`);
  console.error(
    "usage: deno task journey:box " +
      "/absolute/path/to/pagu /absolute/path/to/pagu-box",
  );
  Deno.exit(message ? 64 : 0);
}

function cleanEnvironment(): Record<string, string> {
  const environment = Deno.env.toObject();
  for (
    const name of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "OPENROUTER_API_KEY",
    ]
  ) {
    delete environment[name];
  }
  return environment;
}

async function observe(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<CommandObservation> {
  const output = await new Deno.Command(executable, {
    args: [...args],
    cwd,
    env: environment,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    success: output.success,
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

async function compare(
  name: string,
  pagu: string,
  compatibility: string,
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<BoxSurfaceCase> {
  const [product, legacy] = await Promise.all([
    observe(pagu, ["box", ...args], cwd, environment),
    observe(compatibility, args, cwd, environment),
  ]);
  return { name, pagu: product, compatibility: legacy };
}

async function main(args = Deno.args): Promise<void> {
  if (args[0] === "-h" || args[0] === "--help") usage();
  if (
    args.length !== 2 ||
    args.some((arg) => !arg.startsWith("/"))
  ) {
    usage("both packaged executable paths must be absolute");
  }
  const [pagu, compatibility] = args;
  const sourceRoot = decodeURIComponent(
    new URL("../", import.meta.url).pathname,
  ).replace(/\/$/, "");
  const policy = `${sourceRoot}/profiles/proof.json`;
  const environment = cleanEnvironment();
  const cases = await Promise.all([
    compare(
      "help",
      pagu,
      compatibility,
      ["--help"],
      sourceRoot,
      environment,
    ),
    compare(
      "schema explanation",
      pagu,
      compatibility,
      ["--policy", policy, "--explain"],
      sourceRoot,
      environment,
    ),
    compare(
      "boxed launch",
      pagu,
      compatibility,
      [
        "--policy",
        policy,
        "--",
        "deno",
        "eval",
        'console.log("box-command-journey"); console.log(Deno.env.get("PATH"));',
      ],
      sourceRoot,
      environment,
    ),
  ]);
  assertBoxSurfacesEquivalent(cases);
  const help = cases.find((item) => item.name === "help")!;
  const explanation = cases.find((item) => item.name === "schema explanation")!;
  const launch = cases.find((item) => item.name === "boxed launch")!;
  requireClaim(help.pagu.stdout.includes("pagu-box"), "help is not box help");
  const compiled = JSON.parse(explanation.pagu.stdout);
  requireClaim(
    compiled?.version === 0 && compiled?.platform === "linux" &&
      Array.isArray(compiled?.argv),
    "schema explanation is not compiled Linux policy evidence",
  );
  requireClaim(
    launch.pagu.stdout.startsWith("box-command-journey\n/"),
    "boxed command did not report its marker and effective PATH",
  );
  console.log(JSON.stringify(
    {
      journey: "human host -> pagu box -> directly boxed command",
      comparisons: cases.map((item) => item.name),
      compatibility: "exact",
      modelCalls: 0,
      result: "pass",
    },
    null,
    2,
  ));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `box-command-journey: ${error instanceof Error ? error.message : error}`,
    );
    Deno.exit(1);
  }
}
