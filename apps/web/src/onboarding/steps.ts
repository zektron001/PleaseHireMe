/**
 * Content for the first-run tour: four chapters, each a handful of steps that
 * spotlight one real element of the workbench and say one accurate thing
 * about it.
 *
 * Chapter three (the sandbox brief) is sourced from docs/THREAT_MODEL.md and
 * docs/WARRANT_TRACK_B.md, not invented - those two are the current,
 * judged-track account of what is actually built and wired versus what is
 * merely designed. Where a control is real but not surfaced in this UI (the
 * container profile, the egress broker), the copy says so as architecture
 * rather than pointing at a badge that does not exist. Chapter two's merge
 * claim is sourced from docs/CONCORD_SHARED_STATE.md the same way.
 */

export interface TourStep {
  /** Stable id for React keys and debugging. Never rendered. */
  readonly id: string;
  readonly chapter: 1 | 2 | 3 | 4;
  readonly chapterTitle: string;
  readonly title: string;
  /** One paragraph per entry. */
  readonly body: readonly string[];
  /**
   * `data-tour` id of the element to spotlight, or null for a centered card
   * with no target - used for framing steps that explain a concept rather
   * than one piece of chrome.
   */
  readonly target: string | null;
}

const AROUND_THE_IDE = "Around the IDE";
const NOT_ALONE = "You are not alone in here";
const SANDBOX = "How the sandbox keeps you safe";
const WHO_CAN_TOUCH = "Who can touch what";

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "welcome",
    chapter: 1,
    chapterTitle: AROUND_THE_IDE,
    title: "Welcome to Agent Launchpad",
    body: [
      "This is a full workbench, not a chat box bolted onto a form: a title bar, an activity rail, a sidebar, tabs, an editor, and a bottom panel.",
      "Four short chapters, skippable any time - let's walk it.",
    ],
    target: "titlebar",
  },
  {
    id: "activity-rail",
    chapter: 1,
    chapterTitle: AROUND_THE_IDE,
    title: "The activity rail",
    body: [
      "Every view in the workbench lives behind one of these icons - files, agents, people, the access list. Click one to swap what the sidebar shows.",
    ],
    target: "activitybar",
  },
  {
    id: "explorer",
    chapter: 1,
    chapterTitle: AROUND_THE_IDE,
    title: "Your documents, for real",
    body: [
      "The Explorer is a real file tree over the documents in this workspace, not a demo fixture. Open one and you're looking at exactly what an Agent would read.",
    ],
    target: "explorer",
  },
  {
    id: "tabs",
    chapter: 1,
    chapterTitle: AROUND_THE_IDE,
    title: "Tabs, like an editor",
    body: [
      "Open several documents at once and switch between them as tabs, the same way you would in any code editor - each one opens the document in the pane beside it.",
    ],
    target: "tabstrip",
  },
  {
    id: "quick-input",
    chapter: 1,
    chapterTitle: AROUND_THE_IDE,
    title: "One box, two modes",
    body: [
      "Type '>' for commands, or anything else to jump straight to a file - the same mode switch VS Code splits across Ctrl+P and Ctrl+Shift+P, unified into one box here.",
    ],
    target: "quick-input",
  },
  {
    id: "panel",
    chapter: 1,
    chapterTitle: AROUND_THE_IDE,
    title: "The bottom panel",
    body: [
      "Everything that isn't the document itself lives here: the live activity feed, problems, build output, and the authorization decisions behind every read and write.",
    ],
    target: "panel",
  },
  {
    id: "statusbar",
    chapter: 1,
    chapterTitle: AROUND_THE_IDE,
    title: "The status bar",
    body: [
      "Small, but live: who's signed in, what your Agent is currently allowed to do to the open document, open conflicts, and whether the decision chain is intact. More on that in chapter three.",
    ],
    target: "statusbar",
  },
  {
    id: "whoami",
    chapter: 2,
    chapterTitle: NOT_ALONE,
    title: "You're signed in as someone",
    body: [
      "Every action here is attributed to a real identity - click a chip to switch who you are. Nothing acts anonymously; every decision downstream is tied back to this.",
    ],
    target: "whoami",
  },
  {
    id: "agents",
    chapter: 2,
    chapterTitle: NOT_ALONE,
    title: "People delegate to Agents",
    body: [
      "Behind every teammate here is their own Agent, acting on their behalf with its own scoped authority - never yours. Several people, and several Agents, can be working the same task at once.",
    ],
    target: "agents",
  },
  {
    id: "concord",
    chapter: 2,
    chapterTitle: NOT_ALONE,
    title: "Nobody's edit disappears",
    body: [
      "When two Agents (or two people) touch the same document close together, writes are serialized and rebased through a three-way merge, not silently overwritten. A genuine same-line conflict is surfaced to resolve, never guessed at.",
    ],
    target: "editor",
  },
  {
    id: "live-feed",
    chapter: 2,
    chapterTitle: NOT_ALONE,
    title: "Watch it happen, live",
    body: [
      "The Agent Live tab streams what every Agent in this workspace is doing as it happens - not just yours.",
    ],
    target: "panel-tabs",
  },
  {
    id: "default-deny",
    chapter: 3,
    chapterTitle: SANDBOX,
    title: "Default-deny, not best-effort",
    body: [
      "Before an Agent can read or write anything, a policy check decides allow or deny. No rule that explicitly allows an action means the answer is deny - permission is never assumed.",
      "That check runs on the server, in the real execution path - never as a suggestion a prompt could talk its way past.",
    ],
    target: null,
  },
  {
    id: "capability-shield",
    chapter: 3,
    chapterTitle: SANDBOX,
    title: "Your live permission, in the corner",
    body: [
      "That shield in the status bar is reading the role your live Agent actually holds on its warrant - not a setting you could leave too permissive by accident.",
    ],
    target: "statusbar",
  },
  {
    id: "decisions-log",
    chapter: 3,
    chapterTitle: SANDBOX,
    title: "Every decision, on the record",
    body: [
      "Every allow and deny - yours and everyone else's - lands in the Decisions tab: who, which Agent, what action, on what resource, and the reason behind any denial.",
      "It's hash-chained, so tampering with one entry is detectable from that point forward - that's what \"chain VALID\" in the status bar is checking.",
    ],
    target: "panel-tabs",
  },
  {
    id: "honest-edges",
    chapter: 3,
    chapterTitle: SANDBOX,
    title: "Honest about the edges",
    body: [
      "Each run happens in its own sandboxed container with a single workspace bound in - never yours, never someone else's. That isolation is real and enforced.",
      "It's a hackathon-grade boundary, not a production guarantee: containers share a kernel, and some of the network hardening this project documents is still landing. Nothing here claims otherwise.",
    ],
    target: null,
  },
  {
    id: "access-panel",
    chapter: 4,
    chapterTitle: WHO_CAN_TOUCH,
    title: "Every live grant, in one place",
    body: [
      "The Access panel lists every warrant that's currently live: who delegated, to which Agent, over which document, with which scopes, and when it expires. Nothing here is inferred - it's the same grant the server checks on every request.",
    ],
    target: "access",
  },
  {
    id: "share-button",
    chapter: 4,
    chapterTitle: WHO_CAN_TOUCH,
    title: "Sharing mints exactly that grant",
    body: [
      "Sharing a document with someone creates a scoped, time-bound, revocable warrant - not a permanent, all-or-nothing invite. Revoke it from the Access panel and the next action that Agent tries is refused immediately.",
    ],
    target: "share-button",
  },
  {
    id: "finale",
    chapter: 4,
    chapterTitle: WHO_CAN_TOUCH,
    title: "That's the tour",
    body: [
      "Explore at your own pace - every view you just saw is one click away on the activity rail. Good luck out there.",
    ],
    target: null,
  },
];
