/**
 * KS-1 / RR-2 - the egress broker.
 *
 * The hardened profile always said the container reaches the model THROUGH a
 * broker. Nothing listened, so KS-7 stripping `ARK_API_KEY` left the Agent with
 * neither a key nor a proxy, and no hardened turn could run at all.
 *
 * What the broker changes, precisely:
 *
 *   before   container holds the real Ark key and calls Ark directly.
 *            Confinement is a rule the policy engine checks after the fact.
 *   after    container holds a PER-RUN CAPABILITY - a token minted for this run
 *            and dead when it ends - and can reach exactly one host. The key
 *            never enters the namespace. Confinement is the topology.
 *
 * The capability is what makes this more than a proxy. A stolen token is worth
 * one run's worth of model calls, on one endpoint, until that run finishes;
 * a stolen API key is worth everything until someone notices.
 *
 * Deliberately NOT a general forward proxy. It speaks to exactly one upstream,
 * fixed at construction from the configured Ark base URL, so "which hosts may
 * the Agent reach" is not a list to be got wrong - it is the absence of any code
 * that could reach a second one.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

export interface EgressEvent {
  readonly agentId: string;
  readonly runId: string;
  readonly decision: "Allow" | "Deny";
  readonly ruleId: string;
  readonly reason: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly bytes: number;
}

export interface BrokerOptions {
  /** The real Ark base URL. The ONLY upstream this broker can speak to. */
  readonly upstreamBaseUrl: string;
  /** The real key. Never leaves this process. */
  readonly apiKey: string;
  /** Resolves a per-run capability to the run that holds it, or null. */
  readonly resolveToken: (token: string) => { agentId: string; runId: string } | null;
  readonly onEgress?: ((event: EgressEvent) => void) | undefined;
}

const UNKNOWN = { agentId: "-", runId: "no-run" };

export class EgressBroker {
  private server: Server | null = null;
  private readonly upstream: URL;

  constructor(private readonly options: BrokerOptions) {
    this.upstream = new URL(options.upstreamBaseUrl);
  }

  get port(): number {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : 0;
  }

  async start(port: number, host = "0.0.0.0"): Promise<number> {
    if (this.server) return this.port;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    // A hung upstream must not hold a socket open forever.
    server.requestTimeout = 0;
    server.headersTimeout = 65_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    return this.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private deny(
    res: ServerResponse,
    status: number,
    ruleId: string,
    reason: string,
    context: { agentId: string; runId: string },
    method: string,
    path: string,
  ): void {
    this.options.onEgress?.({
      ...context,
      decision: "Deny",
      ruleId,
      reason,
      method,
      path,
      status,
      bytes: 0,
    });
    res.writeHead(status, { "content-type": "application/json" });
    // Shaped like an Ark error so the client reports something intelligible
    // rather than a parse failure three layers down.
    res.end(JSON.stringify({ error: { message: reason, type: "aegis_egress_denied" } }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";

    if (path === "/aegis/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, upstream: this.upstream.host }));
      return;
    }

    // The capability arrives where the API key would have been, because that is
    // where the client puts whatever ARK_API_KEY holds.
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      this.deny(res, 401, "KS-1.no-capability", "No run capability presented", UNKNOWN, method, path);
      return;
    }

    const holder = this.options.resolveToken(token);
    if (!holder) {
      // Either forged, or minted for a run that has already ended. Both are the
      // same answer: this token buys nothing now.
      this.deny(
        res,
        403,
        "KS-1.capability-not-live",
        "Run capability is unknown or its run has ended",
        UNKNOWN,
        method,
        path,
      );
      return;
    }

    const upstreamPath =
      this.upstream.pathname.replace(/\/+$/, "") + (path.startsWith("/") ? path : "/" + path);

    const send = this.upstream.protocol === "http:" ? httpRequest : httpsRequest;
    const forwarded = send(
      {
        protocol: this.upstream.protocol,
        hostname: this.upstream.hostname,
        port: this.upstream.port || (this.upstream.protocol === "https:" ? 443 : 80),
        path: upstreamPath,
        method,
        headers: {
          ...stripHopByHop(req.headers),
          // The real credential is attached here and nowhere else.
          authorization: "Bearer " + this.options.apiKey,
          host: this.upstream.host,
        },
      },
      (upstreamRes) => {
        let bytes = 0;
        upstreamRes.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        upstreamRes.on("end", () => {
          this.options.onEgress?.({
            ...holder,
            decision: "Allow",
            ruleId: "KS-1.broker-forward",
            reason: "Forwarded to the single permitted upstream",
            method,
            path,
            status: upstreamRes.statusCode ?? 0,
            bytes,
          });
        });
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        // Piped, not buffered: the Responses API streams, and buffering it would
        // turn every turn into one long silence followed by everything at once.
        upstreamRes.pipe(res);
      },
    );

    forwarded.on("error", (error) => {
      this.deny(
        res,
        502,
        "KS-1.upstream-unreachable",
        "Upstream " + this.upstream.host + " is unreachable: " + error.message,
        holder,
        method,
        path,
      );
    });

    req.pipe(forwarded);
  }
}

/**
 * Headers that describe THIS hop and must not be replayed to the next one.
 * `authorization` is dropped because the whole point is to replace it.
 */
function stripHopByHop(headers: IncomingMessage["headers"]): Record<string, string> {
  const drop = new Set([
    "authorization",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (drop.has(key.toLowerCase()) || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}
