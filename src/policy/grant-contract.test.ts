import { assertEquals } from "@std/assert";
import { GRANT_V0_SCHEMA_ID, parseGrant } from "./schema.ts";

type JsonObject = Record<string, unknown>;

const sorted = (values: readonly string[]): string[] => [...values].sort();

Deno.test("law: published grant v0 contract matches strict decoder shape", async () => {
  const contract = JSON.parse(
    await Deno.readTextFile(
      new URL("../../schemas/grant-v0.schema.json", import.meta.url),
    ),
  ) as JsonObject;
  assertEquals(
    contract.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assertEquals(contract.$id, GRANT_V0_SCHEMA_ID);
  assertEquals(contract.type, "object");
  assertEquals(contract.additionalProperties, false);

  const properties = contract.properties as JsonObject;
  assertEquals(
    sorted(Object.keys(properties)),
    sorted([
      "version",
      "subject",
      "fs",
      "net",
      "env",
      "escalation",
      "parent",
      "expires",
    ]),
  );
  assertEquals(
    sorted(contract.required as string[]),
    sorted(Object.keys(properties)),
  );
  assertEquals(properties.version, { const: 0 });
  assertEquals(properties.subject, { "$ref": "#/$defs/subject" });
  assertEquals(properties.fs, { "$ref": "#/$defs/fs" });
  assertEquals(properties.net, { "$ref": "#/$defs/net" });
  assertEquals(properties.env, { "$ref": "#/$defs/env" });
  assertEquals(properties.escalation, { "$ref": "#/$defs/escalation" });
  assertEquals(properties.parent, { type: ["string", "null"] });
  assertEquals(properties.expires, { type: ["string", "null"] });

  const defs = contract.$defs as Record<string, JsonObject>;
  const stringArray = {
    type: "array",
    items: { type: "string" },
  };
  // The lattice is published as a discriminated union, so a consumer cannot
  // encode a destination-carrying policy the decoder would reject.
  const netUnion = {
    oneOf: [
      {
        type: "object",
        required: ["mode"],
        additionalProperties: false,
        properties: { mode: { const: "off" } },
      },
      {
        type: "object",
        required: ["mode", "allow"],
        additionalProperties: false,
        properties: {
          mode: { const: "gated" },
          allow: { type: "array", items: { type: "string" } },
        },
      },
      {
        type: "object",
        required: ["mode"],
        additionalProperties: false,
        properties: { mode: { const: "host" } },
      },
    ],
  };
  assertEquals(defs, {
    net: netUnion,
    subject: {
      type: "object",
      additionalProperties: false,
      required: ["agent", "label"],
      properties: {
        agent: { type: "string" },
        label: { type: "string" },
      },
    },
    fs: {
      type: "object",
      additionalProperties: false,
      required: ["home", "rw", "ro", "deny"],
      properties: {
        home: { enum: ["rw", "tmpfs"] },
        rw: stringArray,
        ro: stringArray,
        deny: stringArray,
        // Optional: a policy written before the derivation capability existed
        // grants no placement, so it must not become required.
        derive: stringArray,
      },
    },
    env: {
      type: "object",
      additionalProperties: false,
      required: ["pass"],
      properties: { pass: stringArray },
    },
    autoEscalation: {
      type: "object",
      additionalProperties: false,
      required: ["fs.ro", "scope"],
      properties: {
        "fs.ro": { type: "string" },
        scope: { const: "session" },
      },
    },
    escalation: {
      type: "object",
      additionalProperties: false,
      required: ["auto", "refuse"],
      properties: {
        auto: {
          type: "array",
          items: { "$ref": "#/$defs/autoEscalation" },
        },
        refuse: stringArray,
      },
    },
  });

  for (const example of contract.examples as unknown[]) parseGrant(example);

  const denoConfig = JSON.parse(
    await Deno.readTextFile(
      new URL("../../deno.json", import.meta.url),
    ),
  ) as { exports: Record<string, string> };
  assertEquals(
    denoConfig.exports["./grant-v0.schema.json"],
    "./schemas/grant-v0.schema.json",
  );
});
