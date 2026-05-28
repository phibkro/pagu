// pure: writeCapability — the write tool declared as a Capability<void>.
import { type Capability } from "../capability/index.ts";
import { executeScriptProposal } from "./execute.ts";
import { handleWrite, writeToolDef } from "./write.ts";
import { type ScriptEntry } from "../context.ts";
import type { Entry } from "../log/index.ts";
import type { AgentContext } from "../context.ts";

export const writeCapability = {
  entryKind: "script",
  toolName: "write",
  idPrefix: "s",
  data: (_ctx: AgentContext): void => undefined,
  isAvailable: (_data: void): boolean => true,
  toolDef: (_data: void) => writeToolDef,
  toEntry: (args: Record<string, unknown>, id: string): Entry =>
    handleWrite(args, id),
  execute: (entry: Entry, ctx: AgentContext) =>
    executeScriptProposal(entry as ScriptEntry, ctx),
} satisfies Capability<void>;
