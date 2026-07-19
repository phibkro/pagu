// effects: filesystem adapter collecting canonical gate logs for projection.
import { parseLog } from "../log/index.ts";
import {
  projectTelemetry,
  type TelemetryLogV0,
  type TelemetryProjectionOptions,
  type TelemetryViewV0,
} from "./projection.ts";

async function eventLogPath(input: string): Promise<string> {
  const info = await Deno.stat(input);
  return info.isDirectory ? `${input.replace(/\/+$/, "")}/events.md` : input;
}

/** Read one or many state directories (or direct event-log paths) and project
 * them into the versioned in-memory telemetry view. */
export async function collectTelemetry(
  inputs: readonly string[],
  options: TelemetryProjectionOptions,
): Promise<TelemetryViewV0> {
  if (inputs.length === 0) {
    throw new TypeError("at least one state directory is required");
  }
  const logs: TelemetryLogV0[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const path = await Deno.realPath(await eventLogPath(input));
    if (seen.has(path)) continue;
    seen.add(path);
    logs.push({
      version: 0,
      source: path,
      entries: parseLog(await Deno.readTextFile(path)),
    });
  }
  return projectTelemetry(logs, options);
}
