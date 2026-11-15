/** Pure helpers for rendering a unified diff (no React). */

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Above this many lines the viewer shows a "show all" button instead of rendering everything at once. */
export const MAX_RENDER_LINES = 2000;

/**
 * Classifies every line of a unified diff. File header lines (`diff --git`, `---`, `+++`, `index`, `rename from`...)
 * are "meta" only before the first hunk of a file: inside a hunk a line starting with `---` is a deleted line whose
 * content begins with `--`, so it must stay "del".
 */
export function parseDiff(diff: string): DiffLine[] {
  if (!diff) return [];
  const raw = diff.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();
  const out: DiffLine[] = [];
  let inHunk = false;
  for (const text of raw) {
    if (text.startsWith("diff --git ") || (!inHunk && /^(index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename (from|to) |copy (from|to) |Binary files |GIT binary patch)/.test(text))) {
      if (text.startsWith("diff --git ")) inHunk = false;
      out.push({ kind: "meta", text });
    } else if (text.startsWith("@@")) {
      inHunk = true;
      out.push({ kind: "hunk", text });
    } else if (!inHunk) {
      // Anything else outside a hunk (e.g. the "(untracked directory ...)" placeholder) is informational.
      out.push({ kind: "meta", text });
    } else if (text.startsWith("+")) out.push({ kind: "add", text });
    else if (text.startsWith("-")) out.push({ kind: "del", text });
    else if (text.startsWith("\\")) out.push({ kind: "note", text });
    else out.push({ kind: "context", text });
  }
  return out;
}

export function classifyDiffLine(line: string): DiffLineKind {
  return parseDiff(line)[0]?.kind ?? "context";
}

/** Short text label per kind so colour is never the only signal (screen readers get it via aria-label). */
export const KIND_LABEL: Record<DiffLineKind, string> = {
  add: "added",
  del: "removed",
  hunk: "section",
  meta: "header",
  context: "unchanged",
  note: "note",
};
