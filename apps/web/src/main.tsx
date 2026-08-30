import { applyTheme, readChoice } from "./theme";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Applied before first paint, so the page never flashes light then dark.
applyTheme(readChoice());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
