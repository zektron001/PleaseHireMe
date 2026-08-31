/**
 * What the greeting says, and when it has been said.
 *
 * Kept apart from the component because the wording is the part worth
 * testing: a greeting that gets someone's name wrong is worse than no
 * greeting, and "personal" here means *their* name and *their* time of day,
 * not a template with a slot in it.
 *
 * The rule the copy follows: say only what the app actually knows. It knows
 * who signed in and what the clock says. It does not know whether they slept
 * well or what is waiting for them, so it does not pretend to.
 */

/** The name to greet someone by: the first word of how they are listed. */
export function firstName(displayName: string, fallbackHandle: string): string {
  const first = displayName.trim().split(/\s+/)[0] ?? "";
  if (first.length > 0) return first;
  // A human with no display name still has a handle; capitalise it rather
  // than greeting nobody.
  const handle = fallbackHandle.trim();
  if (handle.length === 0) return "there";
  return handle.charAt(0).toUpperCase() + handle.slice(1);
}

export type PartOfDay = "morning" | "afternoon" | "evening";

export function partOfDay(hour: number): PartOfDay {
  if (hour < 5 || hour >= 18) return "evening";
  if (hour < 12) return "morning";
  return "afternoon";
}

/**
 * The line under the handwriting. Two shapes, because the orchestrator is not
 * one of the people the fan-out is delegated *to* - greeting them as though
 * they own a subtask would be a small lie in the first sentence the product
 * ever says.
 */
export function greetingLines(input: {
  displayName: string;
  handle: string;
  hour: number;
}): { headline: string; subtitle: string } {
  const name = firstName(input.displayName, input.handle);
  const when = partOfDay(input.hour);
  const headline = "Good " + when + ", " + name + ".";
  const subtitle =
    input.handle === "orchestrator"
      ? "You split the work, and you decide what gets merged."
      : "Your Agents act for you, and only where you let them.";
  return { headline, subtitle };
}

export const HELLO_SEEN_PREFIX = "launchpad.hello.seen.";

/**
 * Once per human, not once per browser: on a shared demo machine the second
 * person to sign in should get their own hello, not the tail of someone
 * else's. Storage failures are treated as "not seen" for the same reason
 * useTour does - a greeting shown twice is a small cost, and throwing here
 * would take the whole console down over a convenience.
 */
export function hasSeenHello(humanId: string): boolean {
  try {
    return localStorage.getItem(HELLO_SEEN_PREFIX + humanId) === "1";
  } catch {
    return false;
  }
}

export function markHelloSeen(humanId: string): void {
  try {
    localStorage.setItem(HELLO_SEEN_PREFIX + humanId, "1");
  } catch {
    // Persisting is a convenience. The greeting still closes.
  }
}
