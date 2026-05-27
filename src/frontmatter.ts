// pure-ish: split a YAML `---` frontmatter header from a markdown body.
// Backed by @std/front-matter (which pulls @std/yaml transitively), so the
// header is real YAML — scalars AND lists/nesting — which roles need.
import { extract } from "@std/front-matter/yaml";

/**
 * Split a markdown doc into its frontmatter `data` (the parsed YAML object)
 * and the remaining `body`. No `---` header → empty data + the body
 * unchanged; a malformed header is treated as body, not an error (we never
 * want a stray `---` in content to crash a read).
 */
export function frontmatter(
  md: string,
): { data: Record<string, unknown>; body: string } {
  if (!md.startsWith("---")) return { data: {}, body: md };
  try {
    const { attrs, body } = extract<Record<string, unknown>>(md);
    return { data: attrs ?? {}, body };
  } catch {
    return { data: {}, body: md };
  }
}
