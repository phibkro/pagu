import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { type CommandRule, recognize } from "./grammar.ts";

// A degenerate rule: fixed prefix, no free args — reproduces matchesPolicy.
const exactRule: CommandRule = {
  program: "deno",
  prefix: ["task", "lint"],
  flags: [],
  positionals: { slots: [], min: 0, max: 0 },
  ceiling: ["allow-run=deno", "allow-read=."],
  source: "explicit",
};

Deno.test("recognize: degenerate rule accepts the exact args", () => {
  assertEquals(recognize(exactRule, ["task", "lint"], []), { ok: true });
});

Deno.test("recognize: degenerate rule rejects different args", () => {
  const r = recognize(exactRule, ["task", "fmt"], []);
  assertEquals(r.ok, false);
});

// A rule with allowlisted boolean flags (no positionals yet).
const flagRule: CommandRule = {
  program: "rg",
  prefix: [],
  flags: [{ name: "--ignore-case" }, { name: "-i" }, { name: "--line-number" }],
  positionals: { slots: [], min: 0, max: 0 },
  ceiling: ["allow-read=."],
  source: "default",
};

Deno.test("recognize: accepts an allowlisted long flag", () => {
  assertEquals(recognize(flagRule, ["--ignore-case"], []), { ok: true });
});

Deno.test("recognize: accepts an allowlisted short flag", () => {
  assertEquals(recognize(flagRule, ["-i"], []), { ok: true });
});

Deno.test("recognize: rejects an unknown flag", () => {
  assertEquals(recognize(flagRule, ["--unknown"], []).ok, false);
});

Deno.test("recognize: rejects a prefix-abbreviated flag", () => {
  assertEquals(recognize(flagRule, ["--ign"], []).ok, false);
});

Deno.test("recognize: rejects bundled short flags", () => {
  assertEquals(recognize(flagRule, ["-in"], []).ok, false);
});

// A rule with value-taking flags.
const valueRule: CommandRule = {
  program: "rg",
  prefix: [],
  flags: [
    { name: "--ignore-case" },
    { name: "--max-count", value: "int" },
    { name: "--type", value: "string" },
  ],
  positionals: { slots: [], min: 0, max: 0 },
  ceiling: ["allow-read=."],
  source: "default",
};

Deno.test("recognize: accepts a value flag with separate value", () => {
  assertEquals(recognize(valueRule, ["--max-count", "5"], []), { ok: true });
});

Deno.test("recognize: accepts a value flag with =value form", () => {
  assertEquals(recognize(valueRule, ["--max-count=5"], []), { ok: true });
});

Deno.test("recognize: accepts a string-valued flag", () => {
  assertEquals(recognize(valueRule, ["--type", "ts"], []), { ok: true });
});

Deno.test("recognize: rejects a non-int value for an int flag", () => {
  assertEquals(recognize(valueRule, ["--max-count", "abc"], []).ok, false);
});

Deno.test("recognize: rejects a value flag missing its value", () => {
  assertEquals(recognize(valueRule, ["--max-count"], []).ok, false);
});

Deno.test("recognize: rejects =value on a boolean flag", () => {
  assertEquals(recognize(valueRule, ["--ignore-case=x"], []).ok, false);
});

// A rule with positional args (string slots + repeatable tail) and a flag.
const posRule: CommandRule = {
  program: "echo",
  prefix: [],
  flags: [{ name: "-i" }],
  positionals: { slots: ["string"], rest: "string", min: 1, max: 3 },
  ceiling: [],
  source: "default",
};

Deno.test("recognize: accepts the minimum positional count", () => {
  assertEquals(recognize(posRule, ["hello"], []), { ok: true });
});

Deno.test("recognize: accepts up to the maximum positional count", () => {
  assertEquals(recognize(posRule, ["a", "b", "c"], []), { ok: true });
});

Deno.test("recognize: rejects fewer than the minimum positionals", () => {
  assertEquals(recognize(posRule, [], []).ok, false);
});

Deno.test("recognize: rejects more than the maximum positionals", () => {
  assertEquals(recognize(posRule, ["a", "b", "c", "d"], []).ok, false);
});

Deno.test("recognize: accepts a flag preceding positionals", () => {
  assertEquals(recognize(posRule, ["-i", "hello"], []), { ok: true });
});

Deno.test("recognize: validates positional slot type", () => {
  const intSlot: CommandRule = {
    ...posRule,
    positionals: { slots: ["int"], min: 1, max: 1 },
  };
  assertEquals(recognize(intSlot, ["42"], []), { ok: true });
  assertEquals(recognize(intSlot, ["nope"], []).ok, false);
});

// --- path containment (property-based) ---

const ROOT = "/repo";
const pathRule: CommandRule = {
  program: "rg",
  prefix: [],
  flags: [],
  positionals: { slots: [], rest: "path", min: 1, max: 5 },
  ceiling: ["allow-read=/repo"],
  source: "default",
};

// Relative paths built from safe segments — always resolve under ROOT.
const safeRelPath = fc
  .array(fc.constantFrom("src", "lib", "a", "b", "c", "deep", "mod"), {
    minLength: 1,
    maxLength: 4,
  })
  .map((segs) => segs.join("/"));

Deno.test("recognize: accepts any in-scope path positional (property)", () => {
  fc.assert(
    fc.property(
      fc.array(safeRelPath, { minLength: 1, maxLength: 5 }),
      (paths) => recognize(pathRule, paths, [ROOT], ROOT).ok === true,
    ),
  );
});

// Paths that always land outside ROOT: absolute elsewhere, or enough "../".
const escapingPath = fc.oneof(
  fc.constantFrom("/etc/passwd", "/usr/bin/env", "/root/.ssh/id_rsa"),
  fc.integer({ min: 1, max: 6 }).map((n) => "../".repeat(n) + "etc"),
);

Deno.test("recognize: rejects any out-of-scope path positional (property)", () => {
  fc.assert(
    fc.property(
      escapingPath,
      (p) => recognize(pathRule, [p], [ROOT], ROOT).ok === false,
    ),
  );
});

// A rule with an enum-typed flag value.
const enumRule: CommandRule = {
  program: "git",
  prefix: ["log"],
  flags: [{ name: "--format", value: { enum: ["oneline", "short", "full"] } }],
  positionals: { slots: [], min: 0, max: 0 },
  ceiling: ["allow-run=git", "allow-read=."],
  source: "default",
};

Deno.test("recognize: accepts a value in the declared enum", () => {
  assertEquals(recognize(enumRule, ["log", "--format", "oneline"], []), {
    ok: true,
  });
});

Deno.test("recognize: accepts enum value in =value form", () => {
  assertEquals(recognize(enumRule, ["log", "--format=short"], []), {
    ok: true,
  });
});

Deno.test("recognize: rejects a value not in the enum", () => {
  assertEquals(
    recognize(enumRule, ["log", "--format", "medium"], []).ok,
    false,
  );
});

Deno.test("recognize: rejects an empty string not in the enum", () => {
  assertEquals(recognize(enumRule, ["log", "--format", ""], []).ok, false);
});

// --- invariant guards (whole-recogniser) ---

// Totality: untrusted agent input must never throw — only ok/why-rejected.
Deno.test("recognize: total — never throws on arbitrary args (property)", () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { maxLength: 8 }), (args) => {
      recognize(pathRule, args, [ROOT], ROOT);
      recognize(valueRule, args, []);
      recognize(exactRule, args, []);
      return true;
    }),
  );
});

// Negative injection: a disallowed flag anywhere in an otherwise-valid
// sequence must always be rejected (the "dangerous strings don't run" claim).
Deno.test("recognize: injecting a disallowed flag always rejects (property)", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("--ignore-case", "--line-number"), {
        maxLength: 3,
      }),
      fc.constantFrom("--pre", "--search-zip", "-x", "--ign", "-in"),
      fc.nat(),
      (valid, danger, pos) => {
        const args = [...valid];
        args.splice(pos % (args.length + 1), 0, danger);
        return recognize(flagRule, args, []).ok === false;
      },
    ),
  );
});
