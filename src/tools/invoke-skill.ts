// pure
import type { ToolDef } from "../provider/chat.ts";
import type { SkillInvocationEntry } from "../log/schema.ts";

/**
 * The `invoke_skill` tool. The model names a pre-approved skill script;
 * the orchestrator resolves and runs the verbatim script body. The agent
 * never sees or copies the script content — it only names what to invoke.
 *
 * Dynamic behaviour is encoded as `args` passed to the runner; the script
 * body itself never changes. This is distinct from `write`, which is for
 * arbitrary agent-authored scripts that require per-run human approval.
 */
export function invokeSkillToolDef(
  scripts: Array<{ name: string; description: string }>,
): ToolDef {
  const list = scripts.length > 0
    ? " Available: " +
      scripts.map((s) => `${s.name} (${s.description})`).join("; ") + "."
    : "";
  return {
    name: "invoke_skill",
    description:
      `Run a pre-approved skill script without modification. The script runs verbatim as authored — use \`args\` for any dynamic inputs.${list}`,
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          enum: scripts.map((s) => s.name),
          description: "Name of the skill script to invoke.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Optional arguments passed to the script at runtime.",
        },
      },
      required: ["script"],
    },
  };
}

export function handleInvokeSkill(
  toolArgs: Record<string, unknown>,
  id: string,
): SkillInvocationEntry {
  const entry: SkillInvocationEntry = {
    kind: "skill-invoke",
    id,
    script: String(toolArgs.script ?? ""),
  };
  if (
    Array.isArray(toolArgs.args) &&
    toolArgs.args.every((a) => typeof a === "string")
  ) {
    entry.args = toolArgs.args as string[];
  }
  return entry;
}
