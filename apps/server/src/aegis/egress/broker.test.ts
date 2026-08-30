/**
 * The broker's job is to be the only way out, and to be worth less to steal
 * than what it replaces. Both halves are tested here against a real upstream
 * (a local HTTP server standing in for Ark) rather than a mock, because the
 * failure this whole component exists to fix was "the thing was never actually
 * spoken to".
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EgressBroker, type EgressEvent } from "./broker.js";

const REAL_KEY = "ark-the-real-credential";

let upstream: Server;
let upstreamPort = 0;
/** What the upstream actually received, so we can assert on the far side. */
let seen: { authorization: string; path: string; method: string; body: string }[] = [];

beforeEach(async () => {
  seen = [];
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      seen.push({
        authorization: String(req.headers.authorization ?? ""),
        path: req.url ?? "",
        method: req.method ?? "",
        body,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  upstreamPort = address && typeof address === "object" ? address.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

interface Harness {
  broker: EgressBroker;
  port: number;
  events: EgressEvent[];
  stop: () => Promise<void>;
}

async function start(
  tokens: Record<string, { agentId: string; runId: string }>,
): Promise<Harness> {
  const events: EgressEvent[] = [];
  const broker = new EgressBroker({
    upstreamBaseUrl: "http://127.0.0.1:" + upstreamPort + "/api/v3",
    apiKey: REAL_KEY,
    resolveToken: (token) => tokens[token] ?? null,
    onEgress: (event) => events.push(event),
  });
  const port = await broker.start(0, "127.0.0.1");
  return { broker, port, events, stop: () => broker.stop() };
}

const call = (port: number, token: string | null, path = "/responses") =>
  fetch("http://127.0.0.1:" + port + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify({ model: "ep-test", input: "hello" }),
  });

describe("the credential never leaves the host", () => {
  it("swaps a live capability for the real key", async () => {
    const h = await start({ "cap-1": { agentId: "agent_a", runId: "run_1" } });
    const response = await call(h.port, "cap-1");

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    // The far side saw the real credential...
    expect(seen[0]?.authorization).toBe("Bearer " + REAL_KEY);
    // ...and it is nowhere near what the caller sent.
    expect(seen[0]?.authorization).not.toContain("cap-1");
    expect(seen[0]?.path).toBe("/api/v3/responses");
    expect(seen[0]?.body).toContain("ep-test");
    await h.stop();
  });

  it("refuses a caller with no capability at all", async () => {
    const h = await start({});
    const response = await call(h.port, null);
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
    await h.stop();
  });

  it("refuses a forged capability", async () => {
    const h = await start({ "cap-1": { agentId: "agent_a", runId: "run_1" } });
    const response = await call(h.port, "cap-guessed");
    expect(response.status).toBe(403);
    // Nothing reached the upstream, so a forged token costs the key nothing.
    expect(seen).toHaveLength(0);
    await h.stop();
  });
});

describe("a capability is worth one run, not everything", () => {
  it("stops working the moment its run ends", async () => {
    const tokens: Record<string, { agentId: string; runId: string }> = {
      "cap-1": { agentId: "agent_a", runId: "run_1" },
    };
    const h = await start(tokens);

    expect((await call(h.port, "cap-1")).status).toBe(200);

    // The run finishes; GuardedRunner revokes the capability.
    delete tokens["cap-1"];

    const after = await call(h.port, "cap-1");
    expect(after.status).toBe(403);
    // This is the property that makes it a capability rather than a second key:
    // the same token that worked a moment ago now buys nothing.
    expect(seen).toHaveLength(1);
    await h.stop();
  });
});

describe("it can only reach the one upstream it was built with", () => {
  it("sends an absolute URL in the path to the same upstream, not elsewhere", async () => {
    const h = await start({ "cap-1": { agentId: "agent_a", runId: "run_1" } });

    // A client that tries to smuggle a different destination through the request
    // line does not get one: there is no code path to a second host.
    await fetch("http://127.0.0.1:" + h.port + "/http://evil.example/steal", {
      method: "POST",
      headers: { authorization: "Bearer cap-1" },
      body: "{}",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/api/v3/http://evil.example/steal");
    await h.stop();
  });

  it("reports an unreachable upstream as a denial, not a hang", async () => {
    const broker = new EgressBroker({
      upstreamBaseUrl: "http://127.0.0.1:1/api/v3",
      apiKey: REAL_KEY,
      resolveToken: () => ({ agentId: "agent_a", runId: "run_1" }),
    });
    const port = await broker.start(0, "127.0.0.1");
    expect((await call(port, "cap-1")).status).toBe(502);
    await broker.stop();
  });
});

describe("every crossing is evidence", () => {
  it("records the allow with its status and byte count", async () => {
    const h = await start({ "cap-1": { agentId: "agent_a", runId: "run_1" } });
    await call(h.port, "cap-1");
    // The response has to finish before the event is complete.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(h.events[0]).toMatchObject({
      agentId: "agent_a",
      runId: "run_1",
      decision: "Allow",
      ruleId: "KS-1.broker-forward",
      status: 200,
    });
    expect(h.events[0]?.bytes).toBeGreaterThan(0);
    await h.stop();
  });

  it("records the denial, attributing it to no run", async () => {
    const h = await start({});
    await call(h.port, "cap-nope");
    expect(h.events[0]).toMatchObject({
      decision: "Deny",
      ruleId: "KS-1.capability-not-live",
      runId: "no-run",
    });
    await h.stop();
  });

  it("answers a health probe without a capability", async () => {
    const h = await start({});
    const response = await fetch("http://127.0.0.1:" + h.port + "/aegis/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    await h.stop();
  });
});
