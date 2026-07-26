// pure: the one packaging-injected build-provenance fact.
import injected from "./build.json" with { type: "json" };

/**
 * What packaging proved about the source tree that produced this executable.
 *
 * `flake.nix` overwrites `src/provenance/build.json` in the store copy of the
 * source, so every packaged Deno entrypoint — `pagu` and `pagu-mcp` — imports
 * one file written once from the flake's own `self`. The checked-in default is
 * the honest unknown: a development checkout is not a packaged artifact and
 * nothing about it proves which source produced it.
 *
 * The `unknown` type is load-bearing. TypeScript would otherwise infer the
 * shape of the *checked-in* default and hand callers a `revision: null` they
 * could trust without validating, which is precisely the fabricated-provenance
 * failure this module exists to prevent. Widening forces every consumer through
 * `parseSourceProvenance`.
 */
export const INJECTED_SOURCE: unknown = injected;
