// effect: runAdvisor calls the model; formatAdvisory is pure.
import { chat } from "./provider/chat.ts";
import type { ProviderConfig } from "./provider/chat.ts";

const SYSTEM_PROMPT =
  "You are a security reviewer for a script proposed by an AI agent. " +
  "You receive: the user's task, the proposed script, and the permissions it will run with. " +
  "Identify concerns the human reviewer should look at. " +
  "Return ONLY a JSON array of short, specific concern strings. Empty array if no concerns. " +
  'Example: ["allow-run=curl is granted but Deno.Command not found", ' +
  '"reads ~/.ssh/config which the task does not require"]';

/**
 * Call the model as an advisory reviewer. Sends only {task, script, perms} —
 * not the full conversation log — so the review surface is narrow.
 *
 * Returns a list of concern strings, or [] on any failure (fails open: a
 * broken advisor must never block the approval gate).
 */
export async function runAdvisor(params: {
  task: string;
  script: string;
  perms: string[];
  provider: ProviderConfig;
}): Promise<string[]> {
  const { task, script, perms, provider } = params;
  const userMsg = [
    `Task: ${task}`,
    `\nScript:\n${script}`,
    `\nPermissions: ${perms.length > 0 ? perms.join(", ") : "(none)"}`,
  ].join("");
  try {
    const result = await chat(provider, [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ]);
    return parseFlags(result.content);
  } catch {
    return [];
  }
}

function parseFlags(content: string): string[] {
  const match = /\[[\s\S]*\]/.exec(content);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

export function formatAdvisory(flags: string[]): string {
  if (flags.length === 0) return "";
  return flags.map((f) => `[advisory] ${f}`).join("\n");
}
