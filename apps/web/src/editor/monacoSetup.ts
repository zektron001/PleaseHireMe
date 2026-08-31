/**
 * Monaco, wired for Vite and themed to match the workbench.
 *
 * Two deliberate choices:
 *
 *   No `@monaco-editor/react`. Its default loader fetches Monaco from a CDN at
 *   runtime, which is dead the moment the demo machine is offline or behind a
 *   captive portal - the single most avoidable way to lose a demo. Importing
 *   the ESM build means the editor is in the bundle.
 *
 *   `editor.all.js` is in, because that is the editor's own contributions -
 *   find, folding, bracket matching, the context menu - and losing them is
 *   what makes a Monaco embed feel like a textarea. Languages are separate,
 *   and only the ones this platform's shared documents actually are get
 *   imported. An unknown extension still renders, just uncoloured, which is
 *   the right failure mode.
 */

import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

import "monaco-editor/esm/vs/editor/editor.all.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

/*
 * No TypeScript worker. That is the full language service - 6MB - and it buys
 * IntelliSense on documents that are shared prose and config far more often
 * than they are code, and that a human edits a line at a time. The
 * basic-languages contribution below still colours TypeScript; only the
 * type-checking half is gone.
 */
window.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    return new EditorWorker();
  },
};

const EXTENSIONS: Record<string, string> = {
  md: "markdown",
  markdown: "markdown",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  css: "css",
  html: "html",
  py: "python",
  sh: "shell",
  bash: "shell",
  yml: "yaml",
  yaml: "yaml",
};

/** Document ids are repo-relative paths, so the extension is the language. */
export function languageOf(docId: string): string {
  const ext = docId.split(".").at(-1)?.toLowerCase() ?? "";
  return EXTENSIONS[ext] ?? "plaintext";
}

let defined = false;

/**
 * Registers the workbench themes. Colours are the same VS Code values
 * vscode.css assigns to the shell tokens - Monaco cannot read CSS custom
 * properties, so this is the one place a hex is repeated, and the pairing is
 * what keeps the editor from drifting away from the chrome around it.
 */
export function defineThemes(): void {
  if (defined) return;
  defined = true;

  monaco.editor.defineTheme("workbench-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1f1f1f",
      "editor.foreground": "#cccccc",
      "editorLineNumber.foreground": "#6e7681",
      "editorLineNumber.activeForeground": "#cccccc",
      "editor.lineHighlightBackground": "#2a2d2e",
      "editorGutter.background": "#1f1f1f",
      "editorWidget.background": "#202020",
      "editorWidget.border": "#454545",
      "editor.selectionBackground": "#264f78",
      "scrollbarSlider.background": "#79797966",
    },
  });

  monaco.editor.defineTheme("workbench-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#3b3b3b",
      "editorLineNumber.foreground": "#6e7681",
      "editorLineNumber.activeForeground": "#3b3b3b",
      "editor.lineHighlightBackground": "#f0f0f0",
      "editorGutter.background": "#ffffff",
      "editorWidget.background": "#f8f8f8",
      "editorWidget.border": "#c8c8c8",
      "editor.selectionBackground": "#add6ff",
      "scrollbarSlider.background": "#64646466",
    },
  });
}

export { monaco };
