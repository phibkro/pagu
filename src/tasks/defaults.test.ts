import { assertEquals } from "@std/assert";
import { parsePermission } from "../permissions/index.ts";
import { DEFAULT_RULES, findDefaultRule } from "./defaults.ts";
import { recognize } from "./grammar.ts";

const ROOT = "/repo";

function rule(program: string, prefix: string[] = []) {
  const r = DEFAULT_RULES.find(
    (d) =>
      d.program === program &&
      d.prefix.length === prefix.length &&
      d.prefix.every((p, i) => p === prefix[i]),
  );
  if (!r) throw new Error(`no default rule for ${program} ${prefix.join(" ")}`);
  return r;
}

Deno.test("defaults: rg accepts a basic search", () => {
  assertEquals(recognize(rule("rg"), ["foo"], [ROOT], ROOT), { ok: true });
});

Deno.test("defaults: rg accepts flags + a path under root", () => {
  const r = recognize(rule("rg"), ["-i", "-n", "foo", "src"], [ROOT], ROOT);
  assertEquals(r, { ok: true });
});

Deno.test("defaults: rg rejects the --pre code-exec flag", () => {
  assertEquals(
    recognize(rule("rg"), ["--pre", "sh", "foo"], [ROOT], ROOT).ok,
    false,
  );
});

Deno.test("defaults: git log accepts --oneline", () => {
  assertEquals(recognize(rule("git", ["log"]), ["log", "--oneline"], []), {
    ok: true,
  });
});

Deno.test("defaults: git log rejects -c config injection", () => {
  assertEquals(
    recognize(rule("git", ["log"]), ["log", "-c", "core.pager=sh"], []).ok,
    false,
  );
});

Deno.test("defaults: git diff accepts --stat", () => {
  assertEquals(recognize(rule("git", ["diff"]), ["diff", "--stat"], []), {
    ok: true,
  });
});

Deno.test("findDefaultRule: picks by program + prefix", () => {
  assertEquals(findDefaultRule("git", ["log", "--oneline"])?.prefix, ["log"]);
  assertEquals(findDefaultRule("git", ["diff"])?.prefix, ["diff"]);
  assertEquals(findDefaultRule("rg", ["foo"])?.program, "rg");
  assertEquals(findDefaultRule("npm", ["run"]), undefined);
});

// The law: every default rule has free args, so each must be read-only —
// no write/net in its ceiling.
Deno.test("defaults: free-arg rules carry a read-only ceiling", () => {
  for (const r of DEFAULT_RULES) {
    const free = r.flags.length > 0 || r.positionals.max > 0;
    if (!free) continue;
    for (const perm of r.ceiling) {
      const p = parsePermission(perm);
      assertEquals(
        p.flag === "write" || p.flag === "net" || p.flag === "all",
        false,
        `${r.program} ${r.prefix.join(" ")} ceiling must be read-only`,
      );
    }
  }
});
