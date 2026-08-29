import { describe, expect, it } from "vitest";
import { authorize, type AuthzFacts, type AuthzRequest } from "./policy.js";
import { Registry } from "./registry.js";
import { workspaceResource, repoFileResource, INTEGRATION_BRANCH } from "./resources.js";
import { ORCHESTRATOR_ID } from "./orchestrator.js";
import type { HumanPrincipal, Warrant, WarrantAction } from "./types.js";

const ALICE: HumanPrincipal = {
  id: "human:alice",
  handle: "alice",
  displayName: "Alice Chen",
};
const BOB: HumanPrincipal = {
  id: "human:bob",
  handle: "bob",
  displayName: "Bob Okafor",
};

const SUB_A = "sub_alice";
const SUB_B = "sub_bob";
const WS_A = workspaceResource(SUB_A);
const WS_B = workspaceResource(SUB_B);

function facts(overrides: Partial<AuthzFacts> = {}): AuthzFacts {
  return {
    now: 1_000_000,
    resourceOwnerId: null,
    isOrchestrator: false,
    allSubtasksApproved: false,
    pendingSubtaskIds: [],
    ...overrides,
  };
}

function warrantFor(
  human: HumanPrincipal,
  agentId: string,
  subtaskId: string,
  resources: string[],
  overrides: Partial<Warrant> = {},
): Warrant {
  return {
    id: "wrt_" + agentId,
    humanId: human.id,
    agentId,
    subtaskId,
    scopes: ["workspace:read", "workspace:write", "model:invoke", "merge:propose"],
    resources,
    issuedAt: new Date(900_000).toISOString(),
    expiresAt: new Date(2_000_000).toISOString(),
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

function req(
  warrant: Warrant | null,
  action: WarrantAction,
  resource: string,
  f: AuthzFacts = facts(),
  human: HumanPrincipal | null = null,
): AuthzRequest {
  return {
    human,
    agent: warrant
      ? {
          kind: "agent",
          agentId: warrant.agentId,
          ownerId: warrant.humanId,
          warrantId: warrant.id,
          scopes: warrant.scopes,
        }
      : null,
    warrant,
    action,
    resource,
    facts: f,
  };
}

const aliceWarrant = warrantFor(ALICE, "agent_a", SUB_A, [
  WS_A,
  repoFileResource("src/limiter.ts"),
]);

describe("WB default-deny", () => {
  it("denies an Agent with no warrant at all", () => {
    const d = authorize(req(null, "workspace.read", WS_A));
    expect(d.decision).toBe("Deny");
    expect(d.ruleId).toBe("WB-1.no-warrant");
  });

  it("denies when the warrant names a different Agent", () => {
    const stolen = warrantFor(ALICE, "agent_other", SUB_A, [WS_A]);
    const d = authorize({
      ...req(stolen, "workspace.read", WS_A),
      agent: {
        kind: "agent",
        agentId: "agent_a",
        ownerId: ALICE.id,
        warrantId: stolen.id,
        scopes: stolen.scopes,
      },
    });
    expect(d.decision).toBe("Deny");
    expect(d.ruleId).toBe("WB-1.warrant-agent-mismatch");
  });

  it("records the full five-tuple on every decision", () => {
    const d = authorize(req(aliceWarrant, "workspace.read", WS_A));
    expect(d.humanId).toBe(ALICE.id);
    expect(d.agentId).toBe("agent_a");
    expect(d.action).toBe("workspace.read");
    expect(d.resource).toBe(WS_A);
    expect(d.decision).toBe("Allow");
    expect(d.warrantId).toBe(aliceWarrant.id);
  });
});

describe("WB-2 revocation", () => {
  it("denies immediately once the warrant is revoked", () => {
    const revoked = warrantFor(ALICE, "agent_a", SUB_A, [WS_A], {
      revokedAt: new Date(950_000).toISOString(),
      revokedReason: "Alice reassigned the subtask",
    });
    const d = authorize(req(revoked, "workspace.read", WS_A));
    expect(d.decision).toBe("Deny");
    expect(d.ruleId).toBe("WB-2.warrant-revoked");
    expect(d.reason).toContain("Alice reassigned");
  });

  it("revocation beats a resource the warrant would otherwise cover", () => {
    const revoked = warrantFor(ALICE, "agent_a", SUB_A, [WS_A], {
      revokedAt: new Date(950_000).toISOString(),
    });
    expect(authorize(req(revoked, "workspace.write", WS_A)).decision).toBe("Deny");
  });
});

describe("WB-3 expiry", () => {
  it("denies an expired warrant", () => {
    const expired = warrantFor(ALICE, "agent_a", SUB_A, [WS_A], {
      expiresAt: new Date(999_999).toISOString(),
    });
    const d = authorize(req(expired, "workspace.read", WS_A));
    expect(d.decision).toBe("Deny");
    expect(d.ruleId).toBe("WB-3.warrant-expired");
  });

  it("allows right up to the expiry instant", () => {
    const w = warrantFor(ALICE, "agent_a", SUB_A, [WS_A], {
      expiresAt: new Date(1_000_001).toISOString(),
    });
    expect(authorize(req(w, "workspace.read", WS_A)).decision).toBe("Allow");
  });
});

describe("WB-4 scopes", () => {
  it("denies a write when only read was delegated", () => {
    const readOnly = warrantFor(ALICE, "agent_a", SUB_A, [WS_A], {
      scopes: ["workspace:read"],
    });
    const d = authorize(req(readOnly, "workspace.write", WS_A));
    expect(d.decision).toBe("Deny");
    expect(d.ruleId).toBe("WB-4.scope-not-granted");
  });

  it("still allows the read that was delegated", () => {
    const readOnly = warrantFor(ALICE, "agent_a", SUB_A, [WS_A], {
      scopes: ["workspace:read"],
    });
    expect(authorize(req(readOnly, "workspace.read", WS_A)).decision).toBe("Allow");
  });
});

describe("WB-6 cross-owner access - the Track B demo", () => {
  it("allows Alice's Agent to read Alice's workspace", () => {
    const d = authorize(
      req(aliceWarrant, "workspace.read", WS_A, facts({ resourceOwnerId: ALICE.id })),
    );
    expect(d.decision).toBe("Allow");
    expect(d.ruleId).toBe("WB-0.warrant-covers-resource");
  });

  it("DENIES Alice's Agent reading Bob's workspace", () => {
    const d = authorize(
      req(aliceWarrant, "workspace.read", WS_B, facts({ resourceOwnerId: BOB.id })),
    );
    expect(d.decision).toBe("Deny");
    expect(d.ruleId).toBe("WB-6.cross-owner-denied");
    expect(d.reason).toContain("human:bob");
  });

  it("denies the cross-owner write too", () => {
    const d = authorize(
      req(aliceWarrant, "workspace.write", WS_B, facts({ resourceOwnerId: BOB.id })),
    );
    expect(d.decision).toBe("Deny");
    expect(d.ruleId).toBe("WB-6.cross-owner-denied");
  });

  it("denies a repo file the warrant does not name", () => {
    const d = authorize(
      req(aliceWarrant, "workspace.write", repoFileResource("src/secrets.ts")),
    );
    expect(d.decision).toBe("Deny");
    expect(d.ruleId).toBe("WB-5.resource-outside-warrant");
  });

  it("covers files beneath a granted repo prefix", () => {
    const broad = warrantFor(ALICE, "agent_a", SUB_A, [repoFileResource("src/api")]);
    expect(
      authorize(req(broad, "workspace.write", repoFileResource("src/api/routes.ts")))
        .decision,
    ).toBe("Allow");
    expect(
      authorize(req(broad, "workspace.write", repoFileResource("src/apikeys.ts")))
        .decision,
    ).toBe("Deny");
  });
});

describe("WB-7 and WB-8 integration gate", () => {
  const orchestrator: HumanPrincipal = {
    id: ORCHESTRATOR_ID,
    handle: "orchestrator",
    displayName: "Task Orchestrator",
  };

  it("denies integration by a non-orchestrator", () => {
    const d = authorize(
      req(aliceWarrant, "merge.integrate", INTEGRATION_BRANCH, facts(), ALICE),
    );
    expect(d.decision).toBe("Deny");
    expect(d.ruleId).toBe("WB-7.integrate.orchestrator-only");
  });

  it("denies integration while a subtask is unapproved", () => {
    const d = authorize(
      req(
        null,
        "merge.integrate",
        INTEGRATION_BRANCH,
        facts({
          isOrchestrator: true,
          allSubtasksApproved: false,
          pendingSubtaskIds: [SUB_B],
        }),
        orchestrator,
      ),
    );
    expect(d.decision).toBe("Deny");
    expect(d.ruleId).toBe("WB-8.integrate.unapproved-subtask");
    expect(d.reason).toContain(SUB_B);
  });

  it("allows integration once every owner has approved", () => {
    const d = authorize(
      req(
        null,
        "merge.integrate",
        INTEGRATION_BRANCH,
        facts({ isOrchestrator: true, allSubtasksApproved: true }),
        orchestrator,
      ),
    );
    expect(d.decision).toBe("Allow");
    expect(d.ruleId).toBe("WB-0.integrate.all-approved");
  });

  it("denies the orchestrator integrating something that is not the branch", () => {
    const d = authorize(
      req(
        null,
        "merge.integrate",
        WS_A,
        facts({ isOrchestrator: true, allSubtasksApproved: true }),
        orchestrator,
      ),
    );
    expect(d.decision).toBe("Deny");
    expect(d.ruleId).toBe("WB-7.integrate.wrong-resource");
  });
});

describe("Registry", () => {
  it("resolves identity only from a session token", () => {
    const registry = new Registry();
    const alice = registry.addHuman("alice", "Alice Chen");
    const session = registry.openSession(alice.id);

    expect(registry.resolveSession(session.token)?.id).toBe(alice.id);
    expect(registry.resolveSession("human:alice")).toBeNull();
    expect(registry.resolveSession("not-a-token")).toBeNull();
    expect(registry.resolveSession(undefined)).toBeNull();
  });

  it("lets a human revoke only their own warrants", () => {
    const registry = new Registry();
    const alice = registry.addHuman("alice", "A");
    const bob = registry.addHuman("bob", "B");
    const warrant = registry.issue({
      humanId: alice.id,
      agentId: "agent_a",
      subtaskId: SUB_A,
      scopes: ["workspace:read"],
      resources: [WS_A],
    });

    expect(registry.revoke(warrant.id, bob.id, "not mine")).toBe(false);
    expect(registry.isLive(warrant)).toBe(true);

    expect(registry.revoke(warrant.id, alice.id, "reassigned")).toBe(true);
    expect(registry.isLive(warrant)).toBe(false);
  });

  it("expires a warrant on its clock", () => {
    let clock = 1_000;
    const registry = new Registry(() => clock);
    const alice = registry.addHuman("alice", "A");
    const warrant = registry.issue({
      humanId: alice.id,
      agentId: "agent_a",
      subtaskId: SUB_A,
      scopes: ["workspace:read"],
      resources: [WS_A],
      ttlMs: 500,
    });
    expect(registry.isLive(warrant)).toBe(true);
    clock += 600;
    expect(registry.isLive(warrant)).toBe(false);
    expect(registry.warrantForAgent("agent_a")).toBeNull();
  });
});
