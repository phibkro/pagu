// pure: recognize a command invocation against a CommandRule (the safe sublanguage).
import { resolve } from "@std/path";
import { within } from "../permissions/index.ts";

/** A flag value's type. "string" is opaque-safe (e.g. a search pattern). */
export type ValueType = "int" | "string" | "path" | { enum: string[] };

/** An allowlisted canonical flag. `value` undefined ⇒ boolean (no value). */
export interface FlagSpec {
  name: string;
  value?: ValueType;
}

/** The positional-argument shape: fixed leading slots + optional repeatable tail. */
export interface PositionalSpec {
  slots: ValueType[];
  rest?: ValueType;
  min: number;
  max: number;
}

/**
 * One command's safe sublanguage. The degenerate case (no flags, empty
 * positionals, prefix = the full args) is an exact match — today's run_task.
 */
export interface CommandRule {
  program: string;
  prefix: string[];
  flags: FlagSpec[];
  positionals: PositionalSpec;
  ceiling: string[];
  source: "default" | "explicit" | "inferred";
}

export type Recognition = { ok: true } | { ok: false; reason: string };

/** Recognise an invocation's args (one argv token per element) against a rule.
 * `readScope` are the absolute roots a `path` arg must stay within; `base` is
 * the directory relative path args resolve against (the run cwd). */
export function recognize(
  rule: CommandRule,
  args: string[],
  readScope: string[] = [],
  base = "",
): Recognition {
  // Consume the fixed subcommand prefix exactly.
  for (let i = 0; i < rule.prefix.length; i++) {
    if (args[i] !== rule.prefix[i]) {
      return {
        ok: false,
        reason: `expected ${rule.prefix[i]} at position ${i}`,
      };
    }
  }
  const rest = args.slice(rule.prefix.length);

  // Degenerate rule (no free args): nothing may follow the prefix.
  if (rule.flags.length === 0 && rule.positionals.max === 0) {
    return rest.length === 0
      ? { ok: true }
      : { ok: false, reason: `unexpected argument ${rest[0]}` };
  }

  // Recognise the remaining tokens. Flags must match an allowlisted canonical
  // name exactly — no prefix abbreviation, no short-flag bundling (both defeat
  // a denylist, so we allowlist and reject anything else).
  const byName = new Map(rule.flags.map((f) => [f.name, f]));
  const positionals: string[] = [];
  let i = 0;
  let afterDashDash = false;
  while (i < rest.length) {
    const tok = rest[i];
    if (!afterDashDash && tok === "--") {
      afterDashDash = true;
      i += 1;
      continue;
    }
    if (afterDashDash || !tok.startsWith("-")) {
      positionals.push(tok);
      i += 1;
      continue;
    }
    const eq = tok.indexOf("=");
    const name = eq >= 0 ? tok.slice(0, eq) : tok;
    const inlineVal = eq >= 0 ? tok.slice(eq + 1) : undefined;
    const spec = byName.get(name);
    if (!spec) return { ok: false, reason: `flag not allowed: ${name}` };

    if (spec.value === undefined) {
      // Boolean flag: must carry no value.
      if (inlineVal !== undefined) {
        return { ok: false, reason: `flag takes no value: ${name}` };
      }
      i += 1;
      continue;
    }

    // Value flag: the value is inline (--flag=v) or the next token (--flag v).
    let val: string;
    if (inlineVal !== undefined) {
      val = inlineVal;
      i += 1;
    } else {
      if (i + 1 >= rest.length) {
        return { ok: false, reason: `missing value for ${name}` };
      }
      val = rest[i + 1];
      i += 2;
    }
    if (!validateValue(spec.value, val, readScope, base)) {
      return { ok: false, reason: `bad value for ${name}: ${val}` };
    }
  }

  // Validate the collected positionals: count within bounds, each token typed
  // by its slot (then the repeatable `rest` type for any extras).
  const { slots, rest: restType, min, max } = rule.positionals;
  if (positionals.length < min || positionals.length > max) {
    return {
      ok: false,
      reason: `expected ${min}..${max} positionals, got ${positionals.length}`,
    };
  }
  for (let k = 0; k < positionals.length; k++) {
    const type = k < slots.length ? slots[k] : restType;
    if (type === undefined) {
      return { ok: false, reason: `unexpected positional: ${positionals[k]}` };
    }
    if (!validateValue(type, positionals[k], readScope, base)) {
      return { ok: false, reason: `bad positional: ${positionals[k]}` };
    }
  }
  return { ok: true };
}

/** Validate a value token against its declared type. Deny-by-default. */
function validateValue(
  type: ValueType,
  val: string,
  readScope: string[],
  base: string,
): boolean {
  if (type === "int") return /^-?\d+$/.test(val);
  if (type === "string") return true;
  if (type === "path") {
    // Resolve against the run cwd, then require containment within a read root.
    // `resolve` normalises `..`, so an escaping path lands outside every root.
    const abs = resolve(base, val);
    return within(
      [{ flag: "read", scope: abs }],
      readScope.map((r) => ({ flag: "read", scope: r })),
    );
  }
  return false; // enum: implemented when a rule needs it
}
