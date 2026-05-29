// effects: network (fetch the provider's model list) — a net-scoped subprocess
// so the orchestrator itself stays net-less. Spawned with exactly
// --allow-net=<provider host>; reads a ProviderConfig on stdin, writes
// { models: string[] } on stdout.
import { fetchModels, type ProviderConfig } from "../providers/chat.ts";

const cfg = JSON.parse(
  await new Response(Deno.stdin.readable).text(),
) as ProviderConfig;
const models = await fetchModels(cfg);
console.log(JSON.stringify({ models }));
