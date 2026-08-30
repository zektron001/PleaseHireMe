/**
 * Who is who, and what colour they are.
 *
 * The reel gives every collaborator a colour and then reuses it everywhere -
 * on the file tab, on the cursor, in the activity feed - so you can follow one
 * participant across the whole interface without reading a single id. That part
 * is worth copying exactly.
 *
 * The colour is derived from the id, so it is stable across reloads, across
 * browsers and across machines without the server having to assign one. Two
 * people looking at the same session see the same colours.
 */

/**
 * Ten hues, evenly spread, picked to stay distinguishable on both themes. The
 * lightness differs per theme, so this returns the hue and the CSS variables do
 * the rest.
 */
const HUES = [212, 152, 32, 280, 348, 188, 96, 262, 12, 320];

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function hueOf(id: string): number {
  return HUES[hash(id) % HUES.length] ?? 212;
}

/** The colour to paint a participant. Humans and Agents share the same scale. */
export function colorOf(id: string): string {
  return "hsl(" + hueOf(id) + " 72% 52%)";
}

/** A soft fill of the same hue, for selections and row backgrounds. */
export function washOf(id: string, alpha = 0.16): string {
  return "hsl(" + hueOf(id) + " 72% 52% / " + alpha + ")";
}

/** Two letters. A human's handle if we have one, the Agent's suffix otherwise. */
export function initialsOf(humanId: string | null, agentId: string | null): string {
  if (humanId) return humanId.replace(/^human:/, "").slice(0, 2).toUpperCase();
  if (agentId) return agentId.replace(/^agent[_:]/, "").slice(0, 2).toUpperCase();
  return "??";
}

export function humanName(humanId: string | null | undefined): string {
  if (!humanId) return "unassigned";
  const handle = humanId.replace(/^human:/, "");
  return handle.charAt(0).toUpperCase() + handle.slice(1);
}

/** Agent ids are UUID-shaped and unreadable in full. Show enough to match on. */
export function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  const trimmed = value.replace(/^agent[_:]/, "");
  return trimmed.length > 10 ? trimmed.slice(0, 8) + "…" : trimmed;
}

export function clockOf(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString();
}

/** "in 42m", or "expired". Used on warrant rows, where the countdown matters. */
export function expiresIn(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return "in " + minutes + "m";
  return "in " + Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}
