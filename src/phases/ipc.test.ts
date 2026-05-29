import { assertEquals, assertThrows } from "@std/assert";
import { validatePhaseInput } from "./ipc.ts";

const valid = {
  log: [],
  provider: { model: "m", baseURL: "http://x/v1" },
};

Deno.test("validatePhaseInput: rejects a non-array log", () => {
  assertThrows(() => validatePhaseInput({ ...valid, log: "nope" }));
});

Deno.test("validatePhaseInput: accepts a minimal valid input", () => {
  const v = validatePhaseInput(valid);
  assertEquals(v.provider.model, "m");
  assertEquals(v.log, []);
});

Deno.test("validatePhaseInput: rejects a missing provider", () => {
  assertThrows(() => validatePhaseInput({ log: [] }));
});

Deno.test("validatePhaseInput: rejects a non-string provider.model", () => {
  assertThrows(() =>
    validatePhaseInput({ log: [], provider: { model: 5, baseURL: "u" } })
  );
});

Deno.test("validatePhaseInput: rejects a mistyped optional (conceal)", () => {
  assertThrows(() => validatePhaseInput({ ...valid, conceal: 5 }));
});

Deno.test("validatePhaseInput: accepts a fully-populated input", () => {
  const v = validatePhaseInput({
    ...valid,
    provider: { model: "m", baseURL: "u", apiKey: "k", format: "anthropic" },
    agents: "be nice",
    capabilities: "read /x",
    skillScripts: [{ name: "s", description: "d" }],
    allowedTasks: [{
      program: "deno",
      args: ["task", "lint"],
      description: "",
    }],
    commandRules: [{ program: "rg" }],
    conceal: {
      vcsPaths: ["/r/.env"],
      hideGlobs: ["*.pem"],
      secretGlobs: [".env"],
      revealGlobs: [],
      roots: ["/r"],
      enumerated: [],
    },
  });
  assertEquals(v.provider.format, "anthropic");
  assertEquals(v.conceal?.hideGlobs, ["*.pem"]);
});

Deno.test("validatePhaseInput: tolerates all optionals absent", () => {
  const v = validatePhaseInput(valid);
  assertEquals(v.conceal, undefined);
  assertEquals(v.agents, undefined);
});
