/**
 * The command registry.
 *
 * VS Code has a context-key expression language for `when` clauses. That is a
 * parser, an evaluator and a test suite for a feature whose entire job here is
 * to grey out a button - so `enabled` is a plain boolean, computed by the caller
 * at the moment it builds the array, closing over the state it already holds.
 *
 * Every action in the workbench is registered here rather than only wired to a
 * button, because that is what makes the palette worth having: one list, and
 * the keyboard reaches everything the mouse can.
 */

export interface Command {
  id: string;
  /** "Category: Title" is VS Code's convention and the palette relies on it. */
  title: string;
  category: string;
  /** e.g. "ctrl+shift+p". Cmd and Ctrl are treated as the same modifier. */
  key?: string;
  enabled?: boolean;
  /** Hidden from the palette but still reachable by its keybinding. */
  hidden?: boolean;
  run: () => void | Promise<void>;
}

/**
 * Matches a keydown against a spec like "ctrl+shift+p".
 *
 * `ctrl` means "the platform's command modifier", so one spec covers macOS and
 * Windows without a platform switch at every call site.
 */
export function matchKey(event: KeyboardEvent, spec: string): boolean {
  const parts = spec.toLowerCase().split("+");
  const key = parts[parts.length - 1] ?? "";
  const wantCtrl = parts.includes("ctrl") || parts.includes("cmd");
  const wantShift = parts.includes("shift");
  const wantAlt = parts.includes("alt");

  const hasCtrl = event.ctrlKey || event.metaKey;
  if (hasCtrl !== wantCtrl) return false;
  if (event.shiftKey !== wantShift) return false;
  if (event.altKey !== wantAlt) return false;

  const pressed = event.key.toLowerCase();
  if (pressed === key) return true;
  // Shifted punctuation reports the shifted glyph; `code` is stable.
  return event.code.toLowerCase() === "key" + key || event.code.toLowerCase() === key;
}

/** Subsequence match, the same forgiving rule VS Code's palette uses. */
export function fuzzy(needle: string, haystack: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (h.includes(n)) return true;
  let at = 0;
  for (const char of n) {
    if (char === " ") continue;
    at = h.indexOf(char, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}
