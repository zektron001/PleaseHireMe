/**
 * Doc-vs-code contract for §5.1's PDP properties: Total and Fail-closed, plus
 * the decision algebra (default-deny, deny-overrides, monotone in denials)
 * that engine.ts's own header comment states outright.
 *
 * docs/MIDDLEWARE_ARCHITECTURE.md §5.1 (property table):
 *   Total       - "D is defined for every r in R" / "A malformed or unknown
 *                 request denies, never crashes"
 *   Fail-closed - "pi throws => D(r) = Deny" / "A PDP bug degrades to
 *                 refusal, not to permission"
 *
 * policy.test.ts already example-tests one instance of each property
 * (default-deny on an empty bundle, deny-overrides between two fixed rules,
 * fail-closed for one throwing predicate, monotonicity for one fixed denied
 * request). This file generalises those into properties over arbitrary
 * inputs with fast-check, and - the part policy.test.ts never attempts -
 * fuzzes evaluate() with malformed and structurally hostile PolicyRequest
 * shapes to test Total directly, the way §5.1 states it: "a malformed or
 * unknown request denies, never crashes."
 *
 * REAL FINDING pinned here: engine.ts's evaluate() reads
 * `request.context.gate` to build the applicable-rules filter BEFORE the
 * per-rule try/catch that makes a throwing `rule.when` fail closed:
 *
 *   const applicable = this.bundle.rules.filter(
 *     (rule) => rule.gate === request.context.gate,
 *   );
 *
 * A request with a missing or null `context` throws a TypeError right there,
 * before any rule - even the default-deny fallback - is ever consulted. That
 * contradicts Total as stated. The tests below that are expected to fail are
 * marked so explicitly; they are not weakened to pass.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { props } from "../../testing/fuzz.js";
import { PolicyEngine } from "./engine.js";
import { createBundle } from "./bundle.js";
import { principalFor, WORKSPACE_MOUNT } from "../index.js";
import type { PolicyContext, PolicyRequest, PolicyRule } from "../types.js";

const realBundle = createBundle({
  egressAllowlist: ["ark.example.com"],
  workspaceMount: WORKSPACE_MOUNT,
  vaultMarkers: ["/vault", "vault"],
  remainingBudgetUsd: () => 0.5,
});
const engine = new PolicyEngine(realBundle);

const VALID_ACTIONS = ["run.start", "fs.read", "fs.write", "net.connect", "proc.exec"] as const;
const VALID_GATES = [
  "G1.preflight",
  "G2.confinement",
  "G3.interception",
  "G4.postflight",
] as const;

const goodPrincipal = fc.record({
  kind: fc.constant("agent" as const),
  agentId: fc.string({ minLength: 1, maxLength: 24 }),
  ownerId: fc.string({ minLength: 1, maxLength: 24 }),
  scopes: fc.array(
    fc.constantFrom("workspace:rw" as const, "model:invoke" as const, "net:egress" as const),
    { maxLength: 3 },
  ),
});

const goodContext: fc.Arbitrary<PolicyContext> = fc.record({
  runId: fc.string({ minLength: 1, maxLength: 24 }),
  gate: fc.constantFrom(...VALID_GATES),
  estimatedCostUsd: fc.double({ min: 0, max: 1000, noNaN: true }),
  promptSha256: fc.string({ minLength: 1, maxLength: 24 }),
});

const junk = (maxDepth = 3): fc.Arbitrary<unknown> => fc.anything({ maxDepth });

const maybeCorrupt = <T>(good: fc.Arbitrary<T>): fc.Arbitrary<unknown> =>
  fc.oneof(good as fc.Arbitrary<unknown>, junk());

/** Values that are never any of VALID_ACTIONS, by construction. */
const garbageAction: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom("run.stop", "fs.delete", "admin.override", "", "RUN.START", "__proto__", "constructor"),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.string(), { maxLength: 3 }),
);

const protoPollutingKey = fc.constantFrom("__proto__", "constructor", "prototype");

/** Every field independently well-formed or corrupted, plus extra own-keys
 * that happen to be named like prototype-pollution vectors - merged via
 * spread, which (unlike `{ __proto__: x }` literal syntax) creates ordinary
 * own data properties, never a real prototype write. */
const malformedRequest: fc.Arbitrary<unknown> = fc
  .record({
    principal: maybeCorrupt(goodPrincipal),
    action: fc.oneof(fc.constantFrom(...VALID_ACTIONS), garbageAction),
    resource: maybeCorrupt(fc.string({ maxLength: 40 })),
    context: fc.oneof(maybeCorrupt(goodContext), fc.constant(undefined), fc.constant(null)),
  })
  .chain((base) =>
    fc
      .dictionary(protoPollutingKey, junk(2), { maxKeys: 2 })
      .map((extra) => ({ ...base, ...extra })),
  );

describe('§5.1 Total: "a malformed or unknown request denies, never crashes"', () => {
  // The three failing tests in this block (the property below and the two
  // "REAL FINDING, pinned" cases) all trace to one root cause: engine.ts's
  // `rule.gate === request.context.gate` filter reads `request.context`
  // unguarded, before the per-rule try/catch that makes Fail-closed work.
  // Count this as ONE defect (missing/null context => TypeError), not three.
  it("never throws for an arbitrary malformed or unknown PolicyRequest-shaped object", () => {
    fc.assert(
      fc.property(malformedRequest, (candidate) => {
        expect(() => engine.evaluate(candidate as PolicyRequest)).not.toThrow();
      }),
      props(5001, 300),
    );
  });

  it("REAL FINDING, pinned: a request with no context at all crashes evaluate() today", () => {
    // engine.ts line ~54: `rule.gate === request.context.gate` is evaluated
    // OUTSIDE the per-rule try/catch. This assertion matches the doc's
    // claim, not the code: if the engine really is total, this passes. If it
    // throws instead, that is the finding - do not weaken this to catch the
    // throw and pass anyway.
    const noContext = {
      principal: principalFor("x"),
      action: "run.start",
      resource: "run:start",
    };
    expect(() => engine.evaluate(noContext as unknown as PolicyRequest)).not.toThrow();
  });

  it("REAL FINDING, pinned: a request with context explicitly null crashes evaluate() today", () => {
    const nullContext = {
      principal: principalFor("x"),
      action: "run.start",
      resource: "run:start",
      context: null,
    };
    expect(() => engine.evaluate(nullContext as unknown as PolicyRequest)).not.toThrow();
  });
});

describe("§5.1 Total, isolated from the crash above: an unrecognised action never allows", () => {
  it("never returns Allow for a garbage action, given an otherwise well-formed context", () => {
    // Isolates the "never Allow for input it cannot understand" half of
    // Total from the context-crash finding above by holding `context`
    // well-formed here. Every rule predicate in bundle.ts guards on
    // `r.action === "<specific string>"` before touching anything else, and
    // `garbageAction` is constructed to never equal a real action string, so
    // this is expected to hold regardless of how corrupted principal/resource
    // are (the `&&` short-circuits before they are read).
    fc.assert(
      fc.property(
        maybeCorrupt(goodPrincipal),
        garbageAction,
        maybeCorrupt(fc.string({ maxLength: 40 })),
        goodContext,
        (principal, action, resource, context) => {
          const request = { principal, action, resource, context } as unknown as PolicyRequest;
          let verdict;
          try {
            verdict = engine.evaluate(request);
          } catch {
            // A throw is the OTHER finding, already pinned above; this
            // property only asks whether the calls that DO return ever say
            // Allow for input the engine cannot understand.
            return;
          }
          expect(verdict.decision).not.toBe("Allow");
        },
      ),
      props(5002, 300),
    );
  });
});

describe('§5.1 Fail-closed: "a predicate that throws degrades to Deny"', () => {
  const ruleSpec = fc.record({
    id: fc.string({ minLength: 1, maxLength: 10 }),
    effect: fc.constantFrom("Allow" as const, "Deny" as const),
    severity: fc.constantFrom("info" as const, "warn" as const, "critical" as const),
    reason: fc.string({ maxLength: 20 }),
    decides: fc.boolean(),
  });

  it("denies whenever ANY applicable rule's predicate throws, regardless of the other rules", () => {
    fc.assert(
      fc.property(
        goodContext,
        fc.array(ruleSpec, { maxLength: 5 }),
        fc.nat(),
        (context, specs, throwPick) => {
          const gate = context.gate;
          const throwIndex = specs.length === 0 ? -1 : throwPick % specs.length;
          const rules: PolicyRule[] = specs.map((spec, i) => ({
            id: spec.id + "-" + i,
            effect: spec.effect,
            gate,
            severity: spec.severity,
            reason: spec.reason,
            when: i === throwIndex ? () => { throw new Error("predicate bug"); } : () => spec.decides,
          }));
          if (rules.length === 0) {
            // Guarantee at least one applicable, throwing rule even when the
            // array shrinks to empty.
            rules.push({
              id: "solo-throws",
              effect: "Allow",
              gate,
              severity: "info",
              reason: "boom",
              when: () => {
                throw new Error("predicate bug");
              },
            });
          }
          const testEngine = new PolicyEngine({ version: "prop-test", rules });
          const request: PolicyRequest = {
            principal: principalFor("x"),
            action: "run.start",
            resource: "run:start",
            context,
          };
          expect(testEngine.evaluate(request).decision).toBe("Deny");
        },
      ),
      props(5003, 200),
    );
  });
});

describe("§5.1 decision algebra: default-deny on an empty bundle", () => {
  it("denies every well-formed request when the bundle has no rules", () => {
    const empty = new PolicyEngine({ version: "0.0.0", rules: [] });
    fc.assert(
      fc.property(
        goodPrincipal,
        fc.constantFrom(...VALID_ACTIONS),
        fc.string({ maxLength: 40 }),
        goodContext,
        (principal, action, resource, context) => {
          const request = { principal, action, resource, context } as PolicyRequest;
          const verdict = empty.evaluate(request);
          expect(verdict.decision).toBe("Deny");
          expect(verdict.ruleId).toBe("AEGIS.default-deny");
        },
      ),
      props(5004, 100),
    );
  });
});

describe("§5.1 decision algebra: deny-overrides", () => {
  it("lets one matching Deny rule win over any number of matching Allow rules at the same gate, in any position", () => {
    fc.assert(
      fc.property(
        goodContext,
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 4 }),
        fc.nat({ max: 4 }),
        (context, allowIds, splicePoint) => {
          const gate = context.gate;
          const allows: PolicyRule[] = allowIds.map((id, i) => ({
            id: "allow-" + i + "-" + id,
            effect: "Allow",
            gate,
            severity: "info",
            reason: "permissive",
            when: () => true,
          }));
          const deny: PolicyRule = {
            id: "deny-wins",
            effect: "Deny",
            gate,
            severity: "critical",
            reason: "restrictive",
            when: () => true,
          };
          const at = Math.min(splicePoint, allows.length);
          const rules = [...allows.slice(0, at), deny, ...allows.slice(at)];
          const testEngine = new PolicyEngine({ version: "prop-test", rules });
          const request: PolicyRequest = {
            principal: principalFor("x"),
            action: "run.start",
            resource: "run:start",
            context,
          };
          expect(testEngine.evaluate(request).decision).toBe("Deny");
        },
      ),
      props(5005, 200),
    );
  });
});

describe("§5.1 decision algebra: monotone in denials", () => {
  const ruleSpec = fc.record({
    id: fc.string({ minLength: 1, maxLength: 10 }),
    effect: fc.constantFrom("Allow" as const, "Deny" as const),
    severity: fc.constantFrom("info" as const, "warn" as const, "critical" as const),
    reason: fc.string({ maxLength: 20 }),
    decides: fc.boolean(),
  });

  it("never turns an explicit Deny into an Allow by adding more rules at the same gate", () => {
    // NOT "never turns any Deny into an Allow": with zero matching rules the
    // base case denies via default-deny (no rule matched at all), and adding
    // a matching Allow rule then producing Allow is default-deny working
    // exactly as intended, not a monotonicity violation - a first draft of
    // this property asserted the broader claim and failed on the shrunk
    // counterexample baseRules=[], extraRules=[{effect:"Allow",decides:true}],
    // which would falsify a correct implementation, so it was too strong.
    // Monotone-in-denials, as engine.ts's own header states it ("adding a
    // rule can never weaken the policy"), only obliges a Deny that an
    // explicit rule PRODUCED to survive the addition of more rules; a Deny
    // that came from the fallback carries no such obligation. ruleId !==
    // "AEGIS.default-deny" is exactly that distinction (engine.ts line ~75:
    // an explicit Deny rule match returns immediately with `ruleId: rule.id`;
    // only the no-match fallback at the bottom uses the sentinel).
    fc.assert(
      fc.property(
        goodContext,
        fc.array(ruleSpec, { maxLength: 6 }),
        fc.array(ruleSpec, { maxLength: 6 }),
        (context, baseSpecs, extraSpecs) => {
          const gate = context.gate;
          const toRules = (specs: typeof baseSpecs, prefix: string): PolicyRule[] =>
            specs.map((spec, i) => ({
              id: prefix + i + "-" + spec.id,
              effect: spec.effect,
              gate,
              severity: spec.severity,
              reason: spec.reason,
              when: () => spec.decides,
            }));
          const baseRules = toRules(baseSpecs, "base-");
          const extraRules = toRules(extraSpecs, "extra-");
          const request: PolicyRequest = {
            principal: principalFor("x"),
            action: "run.start",
            resource: "run:start",
            context,
          };

          const baseResult = new PolicyEngine({ version: "base", rules: baseRules }).evaluate(
            request,
          );
          fc.pre(baseResult.decision === "Deny" && baseResult.ruleId !== "AEGIS.default-deny");

          const widenedDecision = new PolicyEngine({
            version: "widened",
            rules: [...baseRules, ...extraRules],
          }).evaluate(request).decision;
          expect(widenedDecision).toBe("Deny");
        },
      ),
      props(5006, 300),
    );
  });
});

describe("prototype-polluting keys do not confuse or crash the PDP", () => {
  it("treats a request parsed with __proto__/constructor own-properties as ordinary junk, not a real prototype write", () => {
    // A raw JSON string, not an object literal: `{ __proto__: x }` written
    // directly in source is special grammar that sets the prototype, which
    // would defeat the point of this test. JSON.parse never triggers that
    // exotic behaviour - it creates an ordinary own data property named
    // "__proto__", verified below.
    const raw =
      '{"principal":{"kind":"agent","agentId":"x","ownerId":"y","scopes":[]},' +
      '"action":"run.start","resource":"run:start",' +
      '"context":{"runId":"r1","gate":"G1.preflight","estimatedCostUsd":0,"promptSha256":"abc"},' +
      '"__proto__":{"polluted":true},"constructor":{"polluted":true}}';
    const polluted = JSON.parse(raw);

    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(polluted, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    expect(() => engine.evaluate(polluted)).not.toThrow();
    // No workspace:rw scope on this principal and nothing at G1 denies an
    // empty-scope run.start: falls through to default-deny.
    expect(engine.evaluate(polluted).decision).toBe("Deny");
  });

  it("does not change the decision for an otherwise identical clean request", () => {
    fc.assert(
      fc.property(protoPollutingKey, junk(2), (key, value) => {
        const clean: PolicyRequest = {
          principal: principalFor("x"),
          action: "fs.read",
          resource: "file:/vault/customers.db",
          context: {
            runId: "r",
            gate: "G3.interception",
            estimatedCostUsd: 0,
            promptSha256: "abc",
          },
        };
        // Computed property name via spread: this does NOT trigger the
        // literal `__proto__:` grammar special case, so it is a plain own
        // property even when `key === "__proto__"` (verified in the test
        // above's sibling check).
        const withJunkKey = { ...clean, [key]: value };
        expect(() => engine.evaluate(withJunkKey as PolicyRequest)).not.toThrow();
        expect(engine.evaluate(withJunkKey as PolicyRequest).decision).toBe(
          engine.evaluate(clean).decision,
        );
      }),
      props(5007, 50),
    );
  });
});
