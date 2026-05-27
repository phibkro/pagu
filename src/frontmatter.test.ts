import { assertEquals } from "@std/assert";
import { frontmatter } from "./frontmatter.ts";

Deno.test("frontmatter: parses scalars + lists, returns the body", () => {
  const { data, body } = frontmatter(
    "---\nprovider: openai\nallow:\n  - /x\n  - /y\n---\n\nhello body\n",
  );
  assertEquals(data.provider, "openai");
  assertEquals(data.allow, ["/x", "/y"]); // YAML lists, the reason for @std/yaml
  assertEquals(body.trim(), "hello body");
});

Deno.test("frontmatter: no header → empty data, body unchanged", () => {
  const md = "~~~pagu:message role=user\nhi\n~~~\n";
  assertEquals(frontmatter(md), { data: {}, body: md });
});

Deno.test("frontmatter: a malformed header is treated as body, not an error", () => {
  const md = "--- not a real header\nstuff";
  assertEquals(frontmatter(md), { data: {}, body: md });
});
