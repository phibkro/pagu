import { assertEquals, assertThrows } from "@std/assert";
import {
  parsePolicy,
  PolicyValidationError,
  PROFILE_GRANT_V0_SCHEMA_ID,
} from "./schema.ts";

type JsonObject = Record<string, unknown>;

const sorted = (values: readonly string[]): string[] => [...values].sort();

Deno.test("law: published profile grant v0 contract matches box policy decoder", async () => {
  const contract = JSON.parse(
    await Deno.readTextFile(
      new URL("../../schemas/profile-grant-v0.schema.json", import.meta.url),
    ),
  ) as JsonObject;
  assertEquals(
    contract.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assertEquals(contract.$id, PROFILE_GRANT_V0_SCHEMA_ID);
  assertEquals(contract.type, "object");
  assertEquals(contract.additionalProperties, false);

  const properties = contract.properties as JsonObject;
  assertEquals(
    sorted(Object.keys(properties)),
    sorted(["version", "subject", "fs", "net", "env", "escalation"]),
  );
  assertEquals(
    sorted(contract.required as string[]),
    sorted(Object.keys(properties)),
  );
  assertEquals(properties.version, { const: 0 });
  assertEquals(properties.subject, { "$ref": "#/$defs/subject" });
  assertEquals(properties.fs, { "$ref": "#/$defs/fs" });
  assertEquals(properties.net, { type: "boolean" });
  assertEquals(properties.env, { "$ref": "#/$defs/env" });
  assertEquals(properties.escalation, { "$ref": "#/$defs/escalation" });

  const defs = contract.$defs as Record<string, JsonObject>;
  const stringArray = {
    type: "array",
    items: { type: "string" },
  };
  assertEquals(defs, {
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

  for (const example of contract.examples as unknown[]) parsePolicy(example);
  const example = (contract.examples as JsonObject[])[0];
  assertThrows(
    () => parsePolicy({ ...example, parent: null, expires: null }),
    PolicyValidationError,
    'unknown key "parent"',
  );

  const denoConfig = JSON.parse(
    await Deno.readTextFile(
      new URL("../../deno.json", import.meta.url),
    ),
  ) as { exports: Record<string, string> };
  assertEquals(
    denoConfig.exports["./profile-grant-v0.schema.json"],
    "./schemas/profile-grant-v0.schema.json",
  );
});
