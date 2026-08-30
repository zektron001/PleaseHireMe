/**
 * Monaco, wired to the local package rather than a CDN.
 *
 * `@monaco-editor/react` fetches Monaco from jsdelivr by default, which means
 * the editor silently never loads on a laptop with no internet - exactly the
 * conditions a hackathon demo runs in. Pointing the loader at the copy in
 * node_modules makes it work offline, and makes the bundle honest about its
 * size rather than hiding it behind a network call.
 *
 * The workers are wired the way Vite wants: `?worker` imports, so each one is
 * bundled as its own chunk and only fetched when a language needs it.
 */

import { loader } from "@monaco-editor/react";
/**
 * `monaco-editor/editor.js`, NOT the package root.
 *
 * The root barrel registers every language Monaco ships - about eighty of them,
 * plus the CSS, HTML, JSON and TypeScript language SERVICES and their workers.
 * That made the entry chunk 4.2 MB and the whole build 15 MB, to display a
 * Markdown file. This entry is the editor and nothing else; the four languages
 * below are added back deliberately.
 *
 * Basic-language registrations only: they are Monarch tokenizers, which is
 * exactly what a viewer and a Markdown editor need. The language SERVICES
 * (IntelliSense, and the 7 MB TypeScript worker behind it) are not imported,
 * because nothing here type-checks code in the browser - the Agents do that in
 * their sandboxes.
 */
import * as monaco from "monaco-editor/editor.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
// Note the missing `esm/vs/`. Monaco ships an exports map of
// `"./*.js": "./esm/vs/*.js"`, so the once-standard deep path
// `monaco-editor/esm/vs/...` now resolves to `esm/vs/esm/vs/...` and the build
// fails - while the typecheck passes, because TypeScript is happy either way.
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: () => Worker };
  }
}

// One worker, because only one is needed. Monaco uses it for tokenization and
// diffing; the per-language service workers are not loaded at all.
window.MonacoEnvironment = {
  getWorker(): Worker {
    return new editorWorker();
  },
};

loader.config({ monaco });

/** Two themes that match the console's own tokens rather than Monaco's defaults. */
export function defineThemes(instance: typeof monaco): void {
  instance.editor.defineTheme("concord-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#fbfaf7",
      "editorGutter.background": "#fbfaf7",
      "editor.lineHighlightBackground": "#f4f2ea",
      "editorLineNumber.foreground": "#b4b1a6",
      "editorLineNumber.activeForeground": "#777870",
      "editor.selectionBackground": "#eceadf",
    },
  });
  instance.editor.defineTheme("concord-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1c1c1a",
      "editorGutter.background": "#1c1c1a",
      "editor.lineHighlightBackground": "#26261f",
      "editorLineNumber.foreground": "#6b6a64",
      "editorLineNumber.activeForeground": "#8b8a83",
      "editor.selectionBackground": "#2f2f26",
    },
  });
}

/** Monaco's language id for a repo path. Falls back to plaintext, never guesses. */
export function languageOf(docId: string): string {
  const ext = docId.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    // No JSON language service is loaded, but the tokenizer covers highlighting.
    json: "json",
    md: "markdown",
    markdown: "markdown",
    css: "css",
    html: "html",
    py: "python",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
  };
  return map[ext] ?? "plaintext";
}

export { monaco };
