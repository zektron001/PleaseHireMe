import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { props } from "../testing/fuzz.js";
import { authorize, type AuthzFacts } from "./policy.js";
import { covers, repoFileResource, workspaceResource } from "./resources.js";
import type { Warrant, WarrantAction, WarrantAgentPrincipal, WarrantScope } from "./types.js";

/**
 * Property suite for the pure PDP core (policy.ts's module doc: "the
 * authorization decision, as a pure function... no I/O, no clock, no
 * registry lookups... every rule - especially every DENY - is a table-driven
 * unit test that runs without a server, a container, or a network." and
 * "Combining: deny-overrides on a default-deny base. Absence of a warrant is
 * absence of authority.").
 *
 * Scope note, matching policy.test.ts's own convention: every property below
 * that talks about "warrant"/"agent" is deliberately restricted to actions
 * OTHER than "merge.integrate". merge.integrate (WB-7/WB-8, policy.ts:79-103)
 * is its own orchestrator-gated rule family that never reads `agent` or
 * `warrant` at all — every merge.integrate case in policy.test.ts itself
 * passes `warrant: null` — so "no warrant ⇒ Deny" etc. do not apply to it by
 * design, not by oversight.
 */


const ALL_SCOPES: readonly WarrantScope[] = ["workspace:read", "workspace:write", "model:invoke", "merge:propose"];
const NON_INTEGRATE_ACTIONS: readonly WarrantAction[] = ["workspace.read", "workspace.write", "merge.propose", "task.read"];

const nonIntegrateActionArb = fc.constantFrom(...NON_INTEGRATE_ACTIONS);
const anyActionArb = fc.constantFrom<WarrantAction>(...NON_INTEGRATE_ACTIONS, "merge.integrate");
const scopesArb = fc.subarray(ALL_SCOPES as WarrantScope[]);
const resourceArb = fc.oneof(
  fc.constantFrom(workspaceResource("sub-a"), workspaceResource("sub-b"), repoFileResource("src/a.ts"), repoFileResource("src/api")),
  fc.string(),
);

/**
 * ISO date strings across a wide-enough range to exercise both "issued in
 * the past" and "expires far in the future" without generating anything
 * Date can't parse.
 *
 * TEST BUG (found and fixed here): fc.date() without `noInvalidDate: true`
 * can itself generate an actual Invalid Date (a real, if obscure, JS value —
 * `new Date(NaN)`), which then throws `RangeError: Invalid time value` out
 * of `.toISOString()` before authorize() is ever called. Not a policy.ts
 * finding — a fast-check default this suite needs to opt out of.
 */
const isoDateArb = fc.date({ min: new Date(0), max: new Date(4_102_444_800_000), noInvalidDate: true }).map((d) => d.toISOString());

function mkWarrant(overrides: Partial<Warrant> = {}): Warrant {
  return {
    id: "wrt_test",
    humanId: "human:owner",
    agentId: "agent_test",
    subtaskId: "sub-a",
    scopes: ALL_SCOPES,
    resources: [workspaceResource("sub-a"), repoFileResource("src/a.ts")],
    issuedAt: new Date(0).toISOString(),
    expiresAt: new Date(4_102_444_800_000).toISOString(), // far future by default
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

function mkAgent(warrant: Warrant, overrides: Partial<WarrantAgentPrincipal> = {}): WarrantAgentPrincipal {
  return {
    kind: "agent",
    agentId: warrant.agentId,
    ownerId: warrant.humanId,
    warrantId: warrant.id,
    scopes: warrant.scopes,
    ...overrides,
  };
}

function mkFacts(overrides: Partial<AuthzFacts> = {}): AuthzFacts {
  return {
    now: 1_000_000,
    resourceOwnerId: null,
    isOrchestrator: false,
    allSubtasksApproved: false,
    pendingSubtaskIds: [],
    ...overrides,
  };
}

describe("authorize on malformed input — characterization, not totality", () => {
  /**
   * CORRECTION (this block previously called these "REAL FINDING" — wrong,
   * per an independent reachability review):
   *
   * (a) No doc claims totality for this PDP. policy.ts's module doc says
   *     "pure function... no I/O, no clock, no registry lookups" — a purity
   *     claim, not a "never throws on malformed input" claim. Searched
   *     docs/WARRANT_TRACK_B.md for malformed|never crash|robust|defensive|
   *     untrusted: zero hits. (Contrast aegis/policy/totality.property.test.ts,
   *     whose subject — AEGIS's decision function D — IS covered by an actual
   *     totality claim, MIDDLEWARE_ARCHITECTURE.md:481, and correctly keeps
   *     failing there.)
   *
   * (b) The malformed shapes below are unreachable from the one production
   *     call site. `authorize()` is called from exactly one place outside
   *     tests: warrant/index.ts:151. Its `warrant` always comes from
   *     `registry.principalFor`/the in-memory `WarrantRegistry`, whose only
   *     constructor is `issue()` (registry.ts:106-123), which always sets
   *     `scopes`/`resources` to real (possibly empty) arrays and `expiresAt`
   *     to `new Date(...).toISOString()` — always a parseable date. grep for
   *     readFile/JSON.parse/hydrate/persist/load in registry.ts: zero hits,
   *     so there is no rehydrate-from-disk path that could hand back a
   *     warrant missing a field. `resource` is validated as
   *     `z.string().trim().min(1).max(300)` at routes.ts:40 before it ever
   *     reaches authorize(), and `action` is a zod enum — so a non-string
   *     resource is unreachable too. Every case below only exists because the
   *     test casts past TypeScript with `as unknown as ...`.
   *
   * (c) What would flip these from latent to real: a warrant ever arriving
   *     from disk, from a peer/replica, or from an untrusted request body
   *     without re-validation. If that ever happens, these pins fail and
   *     someone has to decide whether authorize() should validate its input
   *     or the new caller should. Until then, this suite exists to catch
   *     that day arriving, not to claim a bug exists today.
   */
  it("pinned: a warrant missing `scopes` throws (policy.ts:134, `warrant.scopes.includes(required)`) — latent, unreachable via the one production call site", () => {
    const warrant = mkWarrant();
    const { scopes: _scopes, ...rest } = warrant;
    const malformed = rest as unknown as Warrant;
    expect(() =>
      authorize({
        human: null,
        agent: mkAgent(warrant),
        warrant: malformed,
        action: "workspace.read",
        resource: workspaceResource("sub-a"),
        facts: mkFacts(),
      }),
    ).toThrow();
  });

  it("pinned: a warrant missing `resources` throws (policy.ts:157, `warrant.resources.some(...)`) — latent, unreachable via the one production call site", () => {
    const warrant = mkWarrant();
    const { resources: _resources, ...rest } = warrant;
    const malformed = rest as unknown as Warrant;
    expect(() =>
      authorize({
        human: null,
        agent: mkAgent(warrant),
        warrant: malformed,
        action: "workspace.read",
        resource: workspaceResource("sub-a"),
        facts: mkFacts(),
      }),
    ).toThrow();
  });

  it("pinned: a non-string resource throws (resources.ts's isWorkspace()/covers(), reached from policy.ts:144) — latent, unreachable past routes.ts's zod validation", () => {
    const warrant = mkWarrant();
    expect(() =>
      authorize({
        human: null,
        agent: mkAgent(warrant),
        warrant,
        action: "workspace.read",
        resource: 123 as unknown as string,
        facts: mkFacts(),
      }),
    ).toThrow();
  });

  /** Agent present but missing agentId/ownerId does NOT throw — comparisons
   * against `undefined` just fail the mismatch check and deny. Kept as a
   * should-not-throw control alongside the three pinned throws above. */
  it("an agent missing agentId/ownerId does not throw (falls through to a mismatch deny)", () => {
    const warrant = mkWarrant();
    const agent = { kind: "agent" } as unknown as WarrantAgentPrincipal;
    expect(() =>
      authorize({ human: null, agent, warrant, action: "workspace.read", resource: workspaceResource("sub-a"), facts: mkFacts() }),
    ).not.toThrow();
  });
});

describe("authorize does not throw within its actual type domain", () => {
  /**
   * The generic "never throws for a malformed request" property was removed
   * (see the block above): once restricted to shapes the types actually
   * admit — a well-formed Warrant, `resource` as an arbitrary in-domain
   * string, `action` over the real WarrantAction union — that claim is
   * already exercised implicitly by "every decision names a rule" below
   * (which would fail on an uncaught throw, not just a blank ruleId). This
   * property makes it explicit rather than relying on a side effect of that
   * other test.
   */
  it("never throws for a well-formed warrant with any in-domain action/resource/scopes", () => {
    fc.assert(
      fc.property(nonIntegrateActionArb, resourceArb, scopesArb, fc.array(resourceArb, { maxLength: 4 }), (action, resource, scopes, resources) => {
        const warrant = mkWarrant({ scopes, resources });
        expect(() =>
          authorize({ human: null, agent: mkAgent(warrant), warrant, action, resource, facts: mkFacts() }),
        ).not.toThrow();
      }),
      props(3001),
    );
  });
});

describe("WB-1 default-deny", () => {
  /**
   * docs/WARRANT_TRACK_B.md:60-61 — "an Agent with no warrant can do nothing
   * at all (`WB-1.no-warrant`), which is default-deny stated as a data model
   * rather than as a rule." Holds for arbitrary action/resource/facts, not
   * just the specific example in policy.test.ts.
   */
  it("no warrant and no agent is always Deny, for every action except merge.integrate", () => {
    fc.assert(
      fc.property(nonIntegrateActionArb, resourceArb, fc.integer(), (action, resource, now) => {
        const d = authorize({ human: null, agent: null, warrant: null, action, resource, facts: mkFacts({ now }) });
        expect(d.decision).toBe("Deny");
        expect(d.ruleId).toBe("WB-1.no-warrant");
      }),
      props(3002),
    );
  });
});

describe("WB-2 revocation overrides everything else", () => {
  /**
   * docs/WARRANT_TRACK_B.md:161 — "`WB-2.warrant-revoked` | Owner revoked
   * it — checked before everything else | deny". Taken literally: revocation
   * must win regardless of scopes, resource coverage, cross-owner status, or
   * expiry. agent/warrant are built to agree on agentId so the WB-1 mismatch
   * check (which runs first) never intervenes and this is genuinely
   * exercising the revocation check, not a different one.
   */
  it("a revoked warrant is always Deny with ruleId WB-2.warrant-revoked, regardless of scopes/resources/expiry/owner", () => {
    fc.assert(
      fc.property(
        nonIntegrateActionArb,
        resourceArb,
        scopesArb,
        fc.array(resourceArb, { maxLength: 4 }),
        isoDateArb, // revokedAt — any non-null value should trigger this
        isoDateArb, // expiresAt — even a not-yet-expired warrant must still deny
        fc.option(fc.string(), { nil: null }), // resourceOwnerId, incl. a cross-owner mismatch
        (action, resource, scopes, resources, revokedAt, expiresAt, resourceOwnerId) => {
          const warrant = mkWarrant({ scopes, resources, revokedAt, expiresAt });
          const d = authorize({
            human: null,
            agent: mkAgent(warrant),
            warrant,
            action,
            resource,
            facts: mkFacts({ now: 1_000_000, resourceOwnerId }),
          });
          expect(d.decision).toBe("Deny");
          expect(d.ruleId).toBe("WB-2.warrant-revoked");
        },
      ),
      props(3003),
    );
  });
});

describe("WB-3 expiry", () => {
  /** docs/WARRANT_TRACK_B.md:162 — "`WB-3.warrant-expired` | Past
   * `expiresAt` | deny". For a well-formed, parseable expiresAt strictly in
   * the past, expiry must deny regardless of scopes/resources/owner. */
  it("a warrant with a parseable, past expiresAt is always Deny", () => {
    fc.assert(
      fc.property(
        nonIntegrateActionArb,
        resourceArb,
        scopesArb,
        fc.array(resourceArb, { maxLength: 4 }),
        fc.integer({ min: 1, max: 1_000_000 }), // how far in the past
        (action, resource, scopes, resources, pastMs) => {
          const now = 2_000_000;
          const warrant = mkWarrant({ scopes, resources, expiresAt: new Date(now - pastMs).toISOString() });
          const d = authorize({ human: null, agent: mkAgent(warrant), warrant, action, resource, facts: mkFacts({ now }) });
          expect(d.decision).toBe("Deny");
          expect(d.ruleId).toBe("WB-3.warrant-expired");
        },
      ),
      props(3004),
    );
  });

  /**
   * CORRECTION: previously titled "REAL FINDING" — retitled to a pinned
   * characterization per the same reachability review as the malformed-input
   * block above.
   *
   * The arithmetic is real: policy.ts:126 computes
   * `Date.parse(warrant.expiresAt) <= facts.now`. `Date.parse` on an
   * unparseable string returns `NaN`, and every comparison against `NaN` —
   * including `<=` — is `false`, so the expiry check fails OPEN for a
   * warrant whose `expiresAt` cannot be parsed.
   *
   * But it is latent, not live: registry.ts:106-123's `issue()` is the only
   * place a Warrant is constructed in production, and it always sets
   * `expiresAt: new Date(issuedAt + ttlMs).toISOString()` — always a
   * parseable date. There is no persistence/hydrate path (registry.ts has no
   * readFile/JSON.parse), so no warrant with a corrupted `expiresAt` can
   * reach authorize() today.
   *
   * What would flip this to real: `expiresAt` ever arriving from disk, from
   * a peer, or from an untrusted source without re-validation. If that
   * happens, this pin fails and the safe default — deny when expiry can't be
   * confirmed, per docs/WARRANT_TRACK_B.md:155's "deny-overrides on a
   * default-deny base" — becomes worth implementing.
   */
  it("pinned: an unparseable expiresAt fails open today (policy.ts:126, Date.parse('not-a-date') is NaN) — latent, registry.ts's issue() never produces one", () => {
    const warrant = mkWarrant({ expiresAt: "not-a-date" });
    const d = authorize({
      human: null,
      agent: mkAgent(warrant),
      warrant,
      action: "workspace.read",
      resource: workspaceResource("sub-a"),
      facts: mkFacts(),
    });
    expect(d.decision).toBe("Allow");
  });
});

describe("every decision names a rule", () => {
  /** The five-tuple audit record (types.ts's doc on AuthzDecision: "who
   * authorised whom to do what, and why") is useless if ruleId/reason can be
   * blank — there would be nothing to point at in the audit log. Scoped to
   * well-formed requests (the malformed/throwing cases are the totality
   * property's concern, not this one). */
  it("ruleId and reason are always non-empty, for arbitrary well-formed requests", () => {
    fc.assert(
      fc.property(
        anyActionArb,
        resourceArb,
        scopesArb,
        fc.array(resourceArb, { maxLength: 4 }),
        fc.boolean(), // revoked?
        fc.boolean(), // expired?
        fc.boolean(), // isOrchestrator
        fc.boolean(), // allSubtasksApproved
        (action, resource, scopes, resources, revoked, expired, isOrchestrator, allSubtasksApproved) => {
          const now = 2_000_000;
          const warrant = mkWarrant({
            scopes,
            resources,
            revokedAt: revoked ? new Date(now - 1).toISOString() : null,
            expiresAt: new Date(expired ? now - 1 : now + 1_000_000).toISOString(),
          });
          const d = authorize({
            human: null,
            agent: mkAgent(warrant),
            warrant,
            action,
            resource,
            facts: mkFacts({ now, isOrchestrator, allSubtasksApproved }),
          });
          expect(d.ruleId.length).toBeGreaterThan(0);
          expect(d.reason.length).toBeGreaterThan(0);
        },
      ),
      props(3005),
    );
  });
});

describe("WB-5 Allow requires resource coverage", () => {
  /**
   * policy.ts:157-162: the only Allow reachable through the warrant path is
   * gated on `warrant.resources.some((granted) => covers(granted, resource))`.
   * Constructed so "covered" is known independently of authorize() itself —
   * `isCovered` is computed directly from resources.ts's own `covers()` — so
   * this isn't circular.
   */
  it("Allow is never returned when no granted resource covers the requested one", () => {
    fc.assert(
      fc.property(
        nonIntegrateActionArb,
        resourceArb,
        fc.array(resourceArb, { maxLength: 4 }),
        (action, resource, resources) => {
          const warrant = mkWarrant({ resources, scopes: ALL_SCOPES });
          const isCovered = resources.some((granted) => covers(granted, resource));
          fc.pre(!isCovered);
          const d = authorize({
            human: null,
            agent: mkAgent(warrant),
            warrant,
            action,
            resource,
            facts: mkFacts(),
          });
          expect(d.decision).not.toBe("Allow");
        },
      ),
      props(3006),
    );
  });

  /** The mirror sanity check: when a granted resource does cover the
   * requested one and nothing else denies, Allow is actually reachable —
   * otherwise the property above would pass vacuously by the PDP simply
   * never allowing anything. */
  it("REGRESSION: a fully valid warrant covering the resource is Allowed", () => {
    const warrant = mkWarrant();
    const d = authorize({
      human: null,
      agent: mkAgent(warrant),
      warrant,
      action: "workspace.read",
      resource: workspaceResource("sub-a"),
      facts: mkFacts(),
    });
    expect(d.decision).toBe("Allow");
    expect(d.ruleId).toBe("WB-0.warrant-covers-resource");
  });
});
