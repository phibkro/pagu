import { assertEquals } from "@std/assert";
import {
  buildExplicitEntries,
  type CommandEntry,
  loadInferred,
  matchesPolicy,
  saveInferred,
} from "./command-policy.ts";

// --- matchesPolicy ---

const entries: CommandEntry[] = [
  {
    program: "deno",
    args: ["task", "lint"],
    permissions: ["allow-run=deno", "allow-read=."],
    source: "explicit",
  },
  {
    program: "deno",
    args: ["task", "test"],
    permissions: [
      "allow-run=deno",
      "allow-read=.",
      "allow-write=.",
      "allow-env",
      "allow-net",
    ],
    source: "inferred",
    inferredAt: "2026-05-27T00:00:00.000Z",
  },
];

Deno.test("matchesPolicy: exact match returns entry", () => {
  const r = matchesPolicy("deno", ["task", "lint"], entries);
  assertEquals(r?.source, "explicit");
  assertEquals(r?.permissions, ["allow-run=deno", "allow-read=."]);
});

Deno.test("matchesPolicy: different args returns undefined", () => {
  assertEquals(matchesPolicy("deno", ["task", "fmt"], entries), undefined);
});

Deno.test("matchesPolicy: different program returns undefined", () => {
  assertEquals(matchesPolicy("npm", ["task", "lint"], entries), undefined);
});

Deno.test("matchesPolicy: empty entry list returns undefined", () => {
  assertEquals(matchesPolicy("deno", ["task", "lint"], []), undefined);
});

// --- buildExplicitEntries ---

Deno.test("buildExplicitEntries: parses 'program arg1 arg2' strings", () => {
  const entries = buildExplicitEntries([
    "deno task lint",
    "deno task test",
    "npm run build",
  ]);
  assertEquals(entries.length, 3);
  assertEquals(entries[0], {
    program: "deno",
    args: ["task", "lint"],
    permissions: [],
    source: "explicit",
  });
  assertEquals(entries[2].program, "npm");
  assertEquals(entries[2].args, ["run", "build"]);
});

Deno.test("buildExplicitEntries: skips empty strings", () => {
  assertEquals(buildExplicitEntries(["", "  ", "deno lint"]).length, 1);
});

// --- loadInferred / saveInferred ---

Deno.test("loadInferred: returns [] when file absent", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-policy-" });
  assertEquals(await loadInferred(tmp), []);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadInferred / saveInferred round-trip", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-policy-" });
  const data: CommandEntry[] = [
    {
      program: "deno",
      args: ["task", "lint"],
      permissions: ["allow-run=deno"],
      source: "inferred",
      inferredAt: "2026-05-27T00:00:00.000Z",
    },
  ];
  await saveInferred(tmp, data);
  assertEquals(await loadInferred(tmp), data);
  await Deno.remove(tmp, { recursive: true });
});
