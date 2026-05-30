import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import fc from "fast-check";
import {
  composeLayers,
  type ConfigLayer,
  DEFAULTS,
  firstPresent,
  mergeConfig,
  mergeLayer,
  resolveProvider,
  toLayer,
} from "./config.ts";
import { createContext } from "../mod.ts";

Deno.test("resolution: maxTokens flows from config into ctx.provider", async () => {
  const ctx = await createContext({
    provider: "anthropic",
    model: "claude-opus-4-8",
    maxTokens: 8192,
    ui: { status() {}, show() {} },
    approver: () => Promise.resolve("reject"),
  });
  assertEquals(ctx.provider.maxTokens, 8192); // run-state → ProviderConfig wiring
});

Deno.test("mergeLayer: hide/reveal union, hide* toggles right-bias", () => {
  const a: ConfigLayer = { hide: ["*.pem"], hideSecrets: true };
  const b: ConfigLayer = {
    hide: [".env"],
    reveal: ["public.pem"],
    hideSecrets: false,
    hideGitignored: false,
  };
  const m = mergeLayer(a, b);
  assertEquals([...(m.hide ?? [])].sort(), ["*.pem", ".env"]);
  assertEquals(m.reveal, ["public.pem"]);
  assertEquals(m.hideSecrets, false); // right (later) layer wins
  assertEquals(m.hideGitignored, false);
});

Deno.test("toLayer keeps the concealment fields, drops ill-typed", () => {
  assertEquals(
    toLayer({ hide: [".env"], reveal: ["x"], hideSecrets: false, junk: 1 }),
    { hide: [".env"], reveal: ["x"], hideSecrets: false },
  );
  assertEquals(toLayer({ hide: [1, 2] }), {}); // not strings → dropped
  assertEquals(toLayer({ hideGitignored: "no" }), {}); // not boolean → dropped
});

Deno.test("toLayer keeps well-typed known fields, drops the rest", () => {
  assertEquals(
    toLayer({
      provider: "openai",
      model: 5, // ill-typed → dropped
      allow: ["/a", "/b"],
      format: "anthropic",
      junk: true, // unknown → dropped
    }),
    { provider: "openai", allow: ["/a", "/b"], format: "anthropic" },
  );
  assertEquals(toLayer({ allow: ["/a", 3] }), {}); // not all strings → dropped
  assertEquals(toLayer({ maxTokens: 8192 }).maxTokens, 8192); // number kept
  assertEquals(toLayer({ maxTokens: "lots" }).maxTokens, undefined); // ill-typed
});

// --- the role-composition monoid (pure; property-checked) ---

/** Compare layers up to grant-set-equality (list order/repeats don't matter). */
function normalize(l: ConfigLayer): ConfigLayer {
  const n = { ...l };
  if (n.allow) n.allow = [...new Set(n.allow)].sort();
  if (n.write) n.write = [...new Set(n.write)].sort();
  if (n.allowedTasks) n.allowedTasks = [...new Set(n.allowedTasks)].sort();
  if (n.hide) n.hide = [...new Set(n.hide)].sort();
  if (n.reveal) n.reveal = [...new Set(n.reveal)].sort();
  return n;
}
const eqLayer = (a: ConfigLayer, b: ConfigLayer) =>
  assertEquals(normalize(a), normalize(b));

// A layer with an arbitrary subset of fields present (requiredKeys: [] omits
// absent ones rather than setting undefined), exercising every field the merge
// handles — scalars and all three grant lists. Lists are dup-free.
const grant = (xs: string[]) =>
  fc.uniqueArray(fc.constantFrom(...xs), { maxLength: xs.length });
const layerG: fc.Arbitrary<ConfigLayer> = fc.record({
  provider: fc.constantFrom("ollama", "openai"),
  model: fc.constantFrom("a", "b"),
  baseURL: fc.constantFrom("u1", "u2"),
  apiKeyEnv: fc.constantFrom("K1", "K2"),
  format: fc.constantFrom("openai" as const, "anthropic" as const),
  allow: grant(["/x", "/y", "/z"]),
  write: grant(["/w", "/v"]),
  advisor: fc.boolean(),
  advisorProvider: fc.constantFrom("ollama", "openai"),
  advisorModel: fc.constantFrom("a", "b"),
  allowedTasks: grant(["t1", "t2"]),
  hide: grant(["*.pem", ".env"]),
  reveal: grant(["public.pem"]),
  hideSecrets: fc.boolean(),
  hideGitignored: fc.boolean(),
}, { requiredKeys: [] });

Deno.test("mergeLayer monoid: identity — left and right (property)", () => {
  fc.assert(fc.property(layerG, (x) => {
    eqLayer(mergeLayer({}, x), x);
    eqLayer(mergeLayer(x, {}), x);
  }));
  assertEquals(mergeLayer({}, {}), {}); // identity ⋄ identity = identity
});

Deno.test("mergeLayer monoid: associativity (property)", () => {
  fc.assert(fc.property(layerG, layerG, layerG, (a, b, c) => {
    eqLayer(mergeLayer(mergeLayer(a, b), c), mergeLayer(a, mergeLayer(b, c)));
  }));
});

Deno.test("mergeLayer: scalars last-win, grants union (order-independent set)", () => {
  assertEquals(
    mergeLayer({ provider: "ollama", model: "a" }, { provider: "openai" }),
    { provider: "openai", model: "a" },
  );
  // union, deduped, first-seen order
  assertEquals(mergeLayer({ allow: ["/x"] }, { allow: ["/y", "/x"] }).allow, [
    "/x",
    "/y",
  ]);
  // composing a base + two role layers folds to the union
  assertEquals(
    composeLayers([{ allow: ["/a"] }, { allow: ["/b"] }, { allow: ["/a"] }])
      .allow,
    ["/a", "/b"],
  );
});

Deno.test("firstPresent: AGENTS.md preferred, CLAUDE.md is the fallback", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const agents = join(dir, "AGENTS.md");
    const claude = join(dir, "CLAUDE.md");
    await Deno.writeTextFile(claude, "claude instructions");
    // Only CLAUDE.md present → fall back to it.
    assertEquals(await firstPresent(agents, claude), "claude instructions");
    // AGENTS.md present → it wins.
    await Deno.writeTextFile(agents, "agents instructions");
    assertEquals(await firstPresent(agents, claude), "agents instructions");
    // Neither present → empty.
    assertEquals(await firstPresent(join(dir, "x"), join(dir, "y")), "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("empty/garbage parsed yields the base unchanged", () => {
  assertEquals(mergeConfig(DEFAULTS, {}), DEFAULTS);
  assertEquals(mergeConfig(DEFAULTS, null), DEFAULTS);
  assertEquals(mergeConfig(DEFAULTS, "nope"), DEFAULTS);
});

Deno.test("known fields override, unknown keys ignored", () => {
  const merged = mergeConfig(DEFAULTS, {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.5",
    baseURL: "https://example/v1",
    apiKeyEnv: "MY_KEY",
    allow: ["/home/me/docs"],
    bogus: 42,
  });
  assertEquals(merged, {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.5",
    baseURL: "https://example/v1",
    apiKeyEnv: "MY_KEY",
    allow: ["/home/me/docs"],
    hideSecrets: true, // seeded by DEFAULTS
    hideGitignored: true,
  });
});

Deno.test("ill-typed allow is rejected, base kept", () => {
  const base = { ...DEFAULTS, allow: ["keep"] };
  assertEquals(mergeConfig(base, { allow: ["ok", 5] }).allow, ["keep"]);
});

Deno.test("resolveProvider: preset, override, anthropic format, unknown", () => {
  // default ollama preset, no key, default (openai) format
  assertEquals(resolveProvider(DEFAULTS), {
    baseURL: "http://127.0.0.1:11434/v1",
    apiKeyEnv: undefined,
    format: undefined,
  });
  // openrouter preset carries the key env var
  assertEquals(resolveProvider({ ...DEFAULTS, provider: "openrouter" }), {
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    format: undefined,
  });
  // anthropic preset selects its native wire format
  assertEquals(resolveProvider({ ...DEFAULTS, provider: "anthropic" }), {
    baseURL: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    format: "anthropic",
  });
  // explicit overrides win over the preset
  assertEquals(
    resolveProvider({
      ...DEFAULTS,
      provider: "openai",
      baseURL: "https://proxy/v1",
      apiKeyEnv: "PROXY_KEY",
    }),
    { baseURL: "https://proxy/v1", apiKeyEnv: "PROXY_KEY", format: undefined },
  );
  // unknown provider with no baseURL throws
  assertThrows(() => resolveProvider({ ...DEFAULTS, provider: "bogus" }));
});
