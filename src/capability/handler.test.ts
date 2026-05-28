// Tests for handler loading validation and mergeLayer for handlers.
import { assertEquals, assertRejects } from "@std/assert";
import { mergeLayer, toLayer } from "../config/config.ts";
import { loadHandlers } from "./handlers.ts";
import { needsSubprocess, runHandlerStep } from "./index.ts";
import type { Exec } from "./index.ts";

// ── mergeLayer: handlers union ──────────────────────────────────────────────

Deno.test("mergeLayer: unions before-approve handler lists", () => {
  const a = toLayer({ handlers: { "before-approve": ["./a.ts"] } });
  const b = toLayer({ handlers: { "before-approve": ["./b.ts"] } });
  const merged = mergeLayer(a, b);
  assertEquals(merged.handlers?.["before-approve"], ["./a.ts", "./b.ts"]);
});

Deno.test("mergeLayer: deduplicates identical handler paths", () => {
  const a = toLayer({ handlers: { "before-approve": ["./a.ts"] } });
  const b = toLayer({ handlers: { "before-approve": ["./a.ts", "./b.ts"] } });
  const merged = mergeLayer(a, b);
  assertEquals(merged.handlers?.["before-approve"], ["./a.ts", "./b.ts"]);
});

Deno.test("mergeLayer: identity — empty layer preserves handlers", () => {
  const a = toLayer({ handlers: { "before-approve": ["./a.ts"] } });
  const merged = mergeLayer(a, {});
  assertEquals(merged.handlers?.["before-approve"], ["./a.ts"]);
});

// ── loadHandlers: shape validation ─────────────────────────────────────────

Deno.test("loadHandlers: rejects a handler missing the name export", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/bad.ts`;
  await Deno.writeTextFile(
    p,
    `
    export const description = "desc";
    export const permissions: string[] = [];
    export default async () => "continue" as const;
  `,
  );
  await assertRejects(() => loadHandlers([p]), Error, "name");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadHandlers: rejects a handler missing permissions export", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/bad.ts`;
  await Deno.writeTextFile(
    p,
    `
    export const name = "test";
    export const description = "desc";
    export default async () => "continue" as const;
  `,
  );
  await assertRejects(() => loadHandlers([p]), Error, "permissions");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadHandlers: loads a valid handler", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/good.ts`;
  await Deno.writeTextFile(
    p,
    `
    export const name = "audit";
    export const description = "Audits proposals";
    export const permissions: string[] = [];
    export default async () => "continue" as const;
  `,
  );
  const handlers = await loadHandlers([p]);
  assertEquals(handlers.length, 1);
  assertEquals(handlers[0].name, "audit");
  assertEquals(handlers[0].permissions, []);
  assertEquals(handlers[0].path, p);
  await Deno.remove(dir, { recursive: true });
});

// ── needsSubprocess ──────────────────────────────────────────────────────────

Deno.test("needsSubprocess: empty permissions → in-process", () => {
  assertEquals(needsSubprocess([]), false);
});

Deno.test("needsSubprocess: read/write/run/env → in-process", () => {
  assertEquals(
    needsSubprocess([
      "allow-read=/x",
      "allow-write=/y",
      "allow-run=sh",
      "allow-env",
    ]),
    false,
  );
});

Deno.test("needsSubprocess: allow-net → subprocess", () => {
  assertEquals(needsSubprocess(["allow-net=slack.com"]), true);
});

// ── runHandlerStep: in-process halt ─────────────────────────────────────────

Deno.test("runHandlerStep: in-process handler returning done halts pipeline", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/block.ts`;
  await Deno.writeTextFile(
    p,
    `
    export const name = "block";
    export const description = "blocks all";
    export const permissions: string[] = [];
    export default async () => "done" as const;
  `,
  );
  const [handler] = await loadHandlers([p]);
  const exec: Exec = {
    ctx: undefined as never,
    id: "s1",
    title: "s1",
    body: "",
    perms: [],
    rationale: "",
    outcome: "loop",
  };
  const step = runHandlerStep(handler, undefined as never);
  const flow = await step(exec);
  assertEquals(flow, "done");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("runHandlerStep: in-process handler returning continue continues", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/pass.ts`;
  await Deno.writeTextFile(
    p,
    `
    export const name = "pass";
    export const description = "always continues";
    export const permissions: string[] = [];
    export default async () => "continue" as const;
  `,
  );
  const [handler] = await loadHandlers([p]);
  const exec: Exec = {
    ctx: undefined as never,
    id: "s1",
    title: "s1",
    body: "",
    perms: [],
    rationale: "",
    outcome: "loop",
  };
  const step = runHandlerStep(handler, undefined as never);
  const flow = await step(exec);
  assertEquals(flow, "continue");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadHandlers: deduplicates by absolute path", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/good.ts`;
  await Deno.writeTextFile(
    p,
    `
    export const name = "audit";
    export const description = "desc";
    export const permissions: string[] = [];
    export default async () => "continue" as const;
  `,
  );
  const handlers = await loadHandlers([p, p]); // same path twice
  assertEquals(handlers.length, 1);
  await Deno.remove(dir, { recursive: true });
});
