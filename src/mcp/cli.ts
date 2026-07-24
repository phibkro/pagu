// effects: narrow stdio MCP entrypoint for pagu inhabitants.
import { servePaguMcpStdio } from "./server.ts";

export async function main(args = Deno.args): Promise<void> {
  if (args.length !== 0) throw new Error("takes no arguments");
  await servePaguMcpStdio();
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `pagu mcp: ${error instanceof Error ? error.message : error}`,
    );
    Deno.exit(1);
  }
}
