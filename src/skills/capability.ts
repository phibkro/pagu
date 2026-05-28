// pure: skillCapability — invoke_skill declared as a Capability<SkillData>.
import { type Capability } from "../capability/index.ts";
import { executeSkillInvocation } from "./execute.ts";
import { handleInvokeSkill, invokeSkillToolDef } from "./tool.ts";
import { type SkillInvocationEntry } from "../context.ts";
import type { Entry } from "../log/index.ts";
import type { AgentContext } from "../context.ts";

export type SkillData = { name: string; description: string }[];

export const skillCapability = {
  entryKind: "skill-invoke",
  toolName: "invoke_skill",
  idPrefix: "sk",
  data: (ctx: AgentContext): SkillData =>
    ctx.activeSkillScripts.map((s) => ({
      name: s.name,
      description: s.description,
    })),
  isAvailable: (data: SkillData): boolean => data.length > 0,
  toolDef: (data: SkillData) => invokeSkillToolDef(data),
  toEntry: (args: Record<string, unknown>, id: string): Entry =>
    handleInvokeSkill(args, id),
  execute: (entry: Entry, ctx: AgentContext) =>
    executeSkillInvocation(entry as SkillInvocationEntry, ctx),
} satisfies Capability<SkillData>;
