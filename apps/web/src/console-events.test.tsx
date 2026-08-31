import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EventClock,
  groupEventRuns,
  rememberDenials,
  wasRevokedAfter,
} from "./console-events";
import type { ChainEvent } from "./types";

// Shape copied from an actual GET /api/warrant/events response. The server
// contract says `ts`; this fixture deliberately does not invent a client alias.
const serverEvent: ChainEvent = {
  eventId: "7bde52a5-82db-4a57-865d-fc92f4f4a438",
  seq: 52,
  ts: "2026-08-30T16:33:06.843Z",
  runId: "wrt_fbbc6f23-9f56-45d0-b620-f5eb56a8ab12",
  agentId: "agent_dc8bfb34-f433-4560-8bb5-6510df9082e8",
  gate: "B.authz",
  verdict: {
    decision: "Allow",
    ruleId: "WB-0.warrant-covers-resource",
    reason: "Live warrant grants workspace.read on this resource",
    severity: "info",
    policyHash: "warrant-1.0.0",
  },
  evidence: {
    human: "human:alice",
    agent: "agent_dc8bfb34-f433-4560-8bb5-6510df9082e8",
    action: "workspace.read",
    resource: "repo:docs/CHANGELOG.md",
    warrant: "wrt_fbbc6f23-9f56-45d0-b620-f5eb56a8ab12",
  },
  prevHash: "0".repeat(64),
  hash: "a".repeat(64),
};

describe("decision stream presentation", () => {
  it("renders the server timestamp as a real clock time", () => {
    const markup = renderToStaticMarkup(<EventClock event={serverEvent} />);

    expect(markup).toContain('dateTime="2026-08-30T16:33:06.843Z"');
    expect(markup).not.toContain("--:--:--");
    expect(markup).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it("collapses only consecutive identical decisions and keeps denials separate", () => {
    const allowAgain = { ...serverEvent, eventId: "allow-2", seq: 53 };
    const deny = {
      ...serverEvent,
      eventId: "deny-1",
      seq: 54,
      verdict: {
        ...serverEvent.verdict,
        decision: "Deny",
        ruleId: "WB-2.warrant-revoked",
      },
    };

    const runs = groupEventRuns([serverEvent, allowAgain, deny], "all");

    expect(runs).toHaveLength(2);
    expect(runs[0]?.latest.verdict.decision).toBe("Deny");
    expect(runs[0]?.count).toBe(1);
    expect(runs[1]?.count).toBe(2);
  });

  it("keeps an observed denial after it leaves the rolling server window", () => {
    const denied: ChainEvent = {
      ...serverEvent,
      eventId: "denied-event",
      seq: 51,
      verdict: { ...serverEvent.verdict, decision: "Deny" },
    };

    expect(rememberDenials([denied], [serverEvent])).toEqual([denied]);
    expect(rememberDenials([], [serverEvent, denied])).toEqual([denied]);
  });

  it("labels a warrant only when revocation happened after the decision", () => {
    const warrant = {
      id: serverEvent.runId,
      human: "human:alice",
      agent: serverEvent.agentId,
      subtask: "subtask-1",
      live: false,
      revokedAt: "2026-08-30T16:34:06.843Z",
      expiresAt: "2026-08-30T17:33:06.843Z",
    };

    expect(wasRevokedAfter(serverEvent, warrant)).toBe(true);
    expect(
      wasRevokedAfter(serverEvent, {
        ...warrant,
        revokedAt: "2026-08-30T16:32:06.843Z",
      }),
    ).toBe(false);
  });
});
