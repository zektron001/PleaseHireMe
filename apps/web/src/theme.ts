/**
 * Theme selection.
 *
 * Three states, like an editor: explicit light, explicit dark, or follow the
 * operating system. The stored value is the CHOICE, not the resolved theme, so
 * a machine set to "system" keeps tracking the OS after a reload instead of
 * being frozen at whatever it happened to be when the page was last open.
 */

export type ThemeChoice = "light" | "dark" | "system";

const KEY = "launchpad.theme";

export function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    // Private windows and blocked site data both throw here.
    return "system";
  }
}

export function resolve(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Stamps the resolved theme on <html>, which is what the CSS keys off. */
export function applyTheme(choice: ThemeChoice): "light" | "dark" {
  const resolved = resolve(choice);
  document.documentElement.setAttribute("data-theme", resolved);
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Persisting is a convenience; the theme still applies for this session.
  }
  return resolved;
}

/** Calls back when the OS theme changes, but only while following it. */
export function watchSystem(onChange: () => void): () => void {
  try {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  } catch {
    return () => undefined;
  }
}
