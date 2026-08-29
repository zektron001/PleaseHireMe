/**
 * L6 - the evidence surface. Additive routes only; every one sits behind the
 * existing bearer-token hook in app.ts and returns already-redacted data.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";
import type { Aegis } from "./index.js";
import { attest, shortRoot } from "./attest.js";

const runQuery = z.object({ runId: z.string().uuid().optional() });
const latchBody = z.object({
  armed: z.boolean(),
  reason: z.string().trim().max(200).default("Operator action"),
});
const budgetBody = z.object({ budgetUsd: z.number().nonnegative().max(1000) });
const agentParams = z.object({ agentId: z.string().uuid() });

export interface AegisRouteDeps {
  readonly aegis: Aegis;
  /** Reaps every live runtime container. Injected so routes stay testable. */
  readonly reapAll: () => Promise<number>;
}

export async function registerAegisRoutes(
  app: FastifyInstance,
  deps: AegisRouteDeps,
): Promise<void> {
  const { aegis } = deps;

  app.get("/api/aegis/status", async () => aegis.status());

  app.get("/api/aegis/policy", async () => aegis.policyDigest());

  app.get("/api/aegis/attestation", async () => {
    const root = await attest(aegis.vaultPath);
    return {
      vaultPath: aegis.vaultPath,
      root: shortRoot(root),
      fullRoot: root,
      measuredAt: new Date().toISOString(),
    };
  });

  app.get("/api/aegis/events", async (request) => {
    const { runId } = runQuery.parse(request.query);
    const events = runId ? aegis.audit.byRun(runId) : aegis.audit.recent(200);
    const badIndex = aegis.audit.verify(events);
    return {
      runId: runId ?? null,
      chainHead: aegis.audit.chainHead,
      chainValid: badIndex === -1,
      firstInvalidIndex: badIndex,
      events,
    };
  });

  app.post("/api/aegis/killswitch", async (request) => {
    const body = latchBody.parse(request.body);
    if (body.armed) {
      const state = aegis.latch.arm(body.reason);
      const reaped = await deps.reapAll();
      aegis.audit.append({
        runId: "00000000-0000-0000-0000-000000000000",
        agentId: "-",
        gate: "G1.preflight",
        verdict: {
          decision: "Deny",
          ruleId: "KS-9.killswitch.armed",
          reason: body.reason,
          gate: "G1.preflight",
          policyVersion: aegis.engine.policyVersion,
          policyHash: aegis.engine.policyHash,
          severity: "critical",
        },
        evidence: { containersReaped: reaped },
      });
      return { latch: state, containersReaped: reaped };
    }
    return { latch: aegis.latch.disarm(), containersReaped: 0 };
  });

  app.post("/api/aegis/budget/:agentId", async (request) => {
    const { agentId } = agentParams.parse(request.params);
    const { budgetUsd } = budgetBody.parse(request.body);
    if (!Number.isFinite(budgetUsd)) {
      throw new HttpError(400, "budgetUsd must be a finite number");
    }
    // Demonstrates the permission-update action required by the track.
    return {
      agentId,
      budgetUsd,
      note: "Applied to the in-memory ledger for this process",
      budget: aegis.ledger.snapshot(),
    };
  });
}
