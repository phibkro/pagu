// pure: curated category-profile names and shared security assertions.

/** Checked-in ADR-0006 category profiles. Legacy launcher profiles remain a
 * separate compatibility surface. */
export const CATEGORY_PROFILE_NAMES = [
  "advisor",
  "worker",
  "proof",
  "web",
  "infra",
  "orchestrator",
] as const;

export type CategoryProfileName = typeof CATEGORY_PROFILE_NAMES[number];

/** Secret and operator-state paths every curated category refuses. */
export const CATEGORY_SECRET_FLOOR = [
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.azure",
  "~/.config/sops",
  "~/.config/age",
  "~/.config/gh",
  "~/.config/op",
  "~/.config/gcloud",
  "~/.password-store",
  "~/.netrc",
  "~/.bash_history",
  "~/.zsh_history",
  "~/.python_history",
] as const;

/** Narrow a CLI string to a checked-in category name. */
export function isCategoryProfile(
  value: string,
): value is CategoryProfileName {
  return (CATEGORY_PROFILE_NAMES as readonly string[]).includes(value);
}

/** Stable checked-in filename for a category profile. */
export function categoryProfileFilename(name: CategoryProfileName): string {
  return `${name}.json`;
}
