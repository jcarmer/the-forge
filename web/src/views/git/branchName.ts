/** Turns a commit/PR title into a git-safe branch name like `feature/add-login-page` (max 60 chars). */
export function branchFromTitle(title: string, prefix = "feature/"): string {
  const slug = title
    .split("\n")[0]!
    .toLowerCase()
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "") // drop a conventional-commit "feat(scope): " lead
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug ? `${prefix}${slug}` : "";
}
