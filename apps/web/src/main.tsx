import { applyTheme, readChoice } from "./theme";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
// After styles.css on purpose: it retargets that file's tokens to VS Code's
// palette, and console.css hardcodes no colours, so the whole console follows.
import "./vscode.css";

// Applied before first paint, so the page never flashes light then dark.
applyTheme(readChoice());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
