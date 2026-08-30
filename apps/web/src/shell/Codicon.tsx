/**
 * The real VS Code icon font, vendored.
 *
 * `@vscode/codicons` is a 70KB woff/ttf plus a class-per-icon stylesheet, and
 * vite fingerprints the font into the bundle - so this works offline, which a
 * CDN-loaded icon set would not. Extracting a hand-picked SVG subset would cost
 * an afternoon and save nothing measurable.
 */

export function Codicon({
  name,
  className,
  title,
  spin,
}: {
  name: string;
  className?: string;
  title?: string;
  spin?: boolean;
}) {
  return (
    <span
      className={
        "codicon codicon-" +
        name +
        (spin ? " codicon-modifier-spin" : "") +
        (className ? " " + className : "")
      }
      title={title}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
    />
  );
}
