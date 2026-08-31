/**
 * The first thing a human sees after signing in: their name, written out.
 *
 * The handwriting is one continuous SVG path drawn with the stroke-dashoffset
 * technique - the whole outline is dashed with a single dash as long as the
 * path, then the offset is animated to zero, so the line appears to be
 * written rather than faded in. One path, not five letters, because a hand
 * does not lift between them.
 *
 * The pacing is deliberately slower than a normal UI transition. This is the
 * one moment in the product that is allowed to take its time: nothing is
 * loading behind it, nothing is blocked on it, and the whole point is that it
 * feels like being welcomed rather than like a screen resolving.
 *
 * Reduced motion is not a degraded path here. `prefers-reduced-motion` gets
 * the same words, the same warmth and the finished handwriting - it simply
 * arrives instead of being drawn. Nobody gets a lesser greeting.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { Human } from "../types";
import { greetingLines, markHelloSeen } from "./greeting";
import "./hello.css";

/**
 * "hello", as one stroke. Authored against a 410x220 box with the baseline at
 * y=170 and the ascenders reaching y=42, then checked by rendering it - the
 * letterforms are hand-tuned control points, so they are only ever as good as
 * what they actually draw.
 */
const HELLO_PATH =
  "M 60 170 C 62 130 70 80 84 52 C 92 36 104 40 100 58 C 94 82 84 128 86 168 " +
  "C 90 138 100 116 116 114 C 130 112 138 124 136 142 C 134 156 132 164 140 170 " +
  "C 150 162 161 152 168 139 C 175 127 168 116 158 122 C 147 128 143 148 149 161 " +
  "C 155 171 168 172 180 162 " +
  "C 191 150 201 108 209 74 C 215 52 213 42 207 48 C 199 56 199 104 203 134 " +
  "C 206 154 211 166 219 170 " +
  "C 232 157 245 114 253 80 C 259 58 257 48 251 54 C 243 62 243 110 247 141 " +
  "C 250 161 256 170 264 170 " +
  "C 277 172 291 167 297 154 C 303 141 298 126 285 126 C 272 126 265 142 270 155 " +
  "C 275 167 288 172 299 165 C 307 160 314 155 324 151";

export interface HelloProps {
  readonly human: Human;
  readonly onDone: () => void;
  /** Injected in tests; real callers let it read the clock. */
  readonly now?: Date;
}

/** How far in the sequence we are. Each stage only adds; nothing retracts. */
type Stage = "writing" | "named" | "settled";

export function Hello({ human, onDone, now }: HelloProps): JSX.Element {
  const [stage, setStage] = useState<Stage>("writing");
  const pathRef = useRef<SVGPathElement | null>(null);
  const [length, setLength] = useState<number | null>(null);

  const reduced = useMemo(
    () =>
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const { headline, subtitle } = useMemo(
    () =>
      greetingLines({
        displayName: human.displayName,
        handle: human.handle,
        hour: (now ?? new Date()).getHours(),
      }),
    [human.displayName, human.handle, now],
  );

  /**
   * The dash length has to be the path's real length or the stroke either
   * finishes early or never arrives. Measured from the DOM rather than
   * guessed, and only once.
   */
  useEffect(() => {
    const path = pathRef.current;
    if (!path) return;
    // jsdom has no geometry engine; getTotalLength is absent there. Falling
    // back to a constant keeps the component mountable under test, where what
    // is being asserted is the words, not the drawing.
    setLength(typeof path.getTotalLength === "function" ? path.getTotalLength() : 1200);
  }, []);

  /** The sequence. Reduced motion collapses it without skipping any of it. */
  useEffect(() => {
    const write = reduced ? 200 : 2600;
    const name = reduced ? 260 : 900;
    const first = setTimeout(() => setStage("named"), write);
    const second = setTimeout(() => setStage("settled"), write + name);
    return () => {
      clearTimeout(first);
      clearTimeout(second);
    };
  }, [reduced]);

  const finish = (): void => {
    markHelloSeen(human.id);
    onDone();
  };

  /** Escape closes it, like every other overlay in the workbench. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div
      className="hello"
      data-stage={stage}
      data-reduced={reduced ? "1" : "0"}
      role="dialog"
      aria-modal="true"
      aria-label={headline}
    >
      <div className="hello__warmth" aria-hidden="true" />
      <div className="hello__stage">
        <svg
          className="hello__mark"
          viewBox="0 0 410 220"
          role="img"
          aria-label="hello"
          focusable="false"
        >
          <path
            ref={pathRef}
            d={HELLO_PATH}
            className="hello__stroke"
            style={
              length === null
                ? { opacity: 0 }
                : {
                    strokeDasharray: length,
                    strokeDashoffset: reduced ? 0 : length,
                    // The custom property is what the keyframes animate to,
                    // so the measured length reaches CSS without inline
                    // animation shorthand.
                    ["--hello-length" as string]: String(length),
                  }
            }
          />
        </svg>

        <p className="hello__headline">{headline}</p>
        <p className="hello__subtitle">{subtitle}</p>

        <button type="button" className="hello__continue" onClick={finish}>
          Continue
        </button>
      </div>
    </div>
  );
}
