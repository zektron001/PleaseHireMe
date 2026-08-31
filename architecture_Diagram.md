# One-page architecture

One task is split into subtasks. Each subtask has **one accountable human** and
**one Agent acting for them** under a scoped, expiring, revocable *warrant*. The
backend decides every access; the browser decides none of them.

```mermaid
flowchart TB
    subgraph UNTRUSTED["🌐 UNTRUSTED — the browser decides nothing"]
        UI["React workbench<br/>splits, runs, reviews, approves"]
        AG["Agent process<br/>Codex CLI, one per subtask"]
    end

    UI -->|"session token<br/>(never a client-supplied id)"| BOUND
    AG -->|"tool calls"| BOUND

    BOUND{{"═══ TRUST BOUNDARY ═══<br/>Fastify + Zod validate shape;<br/>identity comes from the token, not the payload"}}

    subgraph POLICY["🛡 POLICY PLANE — team-built middleware"]
        direction LR
        W["<b>WARRANT</b> · gate B.authz<br/>who may touch what<br/><i>WB-0 allow · WB-1/4/5/6/9 deny</i>"]
        C["<b>CONCORD</b> · gate C.concord<br/>what happens when many touch it at once<br/><i>CD-section.outside / .not-allocated / .missing</i>"]
        A["<b>AEGIS</b> · gates G1–G4<br/>what the runtime can physically reach<br/><i>KS-1 egress · KS-2 vault · KS-3 fs · KS-6 budget</i>"]
    end

    BOUND --> W
    W -->|"Allow"| C
    W -->|"Deny 403"| DENY["Refusal returned<br/>with the rule that caused it"]
    C -->|"serialised write"| STORE
    C -->|"Deny"| DENY
    W --> A
    A -->|"Deny → contain"| RECOVER

    subgraph RUNTIME["⚙ RUNTIME + DATA"]
        STORE[("SharedDocStore<br/>revisions · provenance<br/>per-line authorship")]
        WS[("Per-subtask workspaces<br/>siblings exist at no path")]
        CHAIN[("Hash-linked audit chain<br/>prevHash → hash")]
    end

    A --> WS
    WS -->|"reconcile"| C
    W -.->|"every decision"| CHAIN
    C -.->|"every decision"| CHAIN
    A -.->|"every decision"| CHAIN
    CHAIN -->|"SSE, live"| UI
    STORE -->|"SSE, live"| UI

    RECOVER["<b>Recovery</b><br/>revoke warrant mid-flight · stop a turn<br/>circuit breaker latches · conflict: ours/theirs/both"]
    RECOVER --> UI
    DENY --> UI

    classDef untrusted fill:#3a2020,stroke:#b3261e,color:#fff
    classDef policy fill:#16233d,stroke:#2f6df6,color:#fff
    classDef runtime fill:#12271e,stroke:#16794a,color:#fff
    classDef bound fill:#2b2410,stroke:#b8860b,color:#fff
    class UNTRUSTED untrusted
    class POLICY policy
    class RUNTIME runtime
    class BOUND bound
```

## Where each thing happens

| | Point | What it is | Where |
| --- | --- | --- | --- |
| **Trust boundary** | Fastify + Zod | Shape is validated; identity is taken from the session token, never from a client-supplied id | `apps/server/src/app.ts`, `warrant/access.ts` |
| **Enforcement** | `B.authz` | One human, one Agent, one warrant. `WB-6.cross-owner-denied` is the required denial | `warrant/plane.ts` |
| **Enforcement** | `C.concord` | Section allocation checked on the **diff**, not the payload, inside the write's critical section | `concord/sections.ts` |
| **Enforcement** | `G1–G4` | Preflight, confinement, interception, postflight around the Agent process | `aegis/policy/bundle.ts` |
| **Instrumentation** | Audit chain | Every decision appended with `prevHash → hash`, so the record is verifiable and ordered | `aegis/audit.ts` |
| **Instrumentation** | Live feed | Provenance, decisions and workspace frames streamed to the browser over SSE | `live/routes.ts` |
| **Recovery** | Revocation | An owner revokes a live warrant; the next action is refused and no container is built | `warrant/routes.ts` |
| **Recovery** | Containment | A policy violation latches that Agent's circuit breaker | `aegis/index.ts` |
| **Recovery** | Merge gate | Closed until every Agent is approved **by its own human** and nothing is contested | `warrant/orchestrator.ts` |

## The one-sentence version of each plane

- **WARRANT** — a delegation plane. A warrant is always *narrower* than the human
  who issued it, expires, and can be revoked mid-flight. Changing the user id in
  a request cannot change the answer, because the id is never read from the
  request.
- **CONCORD** — a concurrency plane. Many Agents edit one document; writes are
  serialised, each Agent is confined to its allocated section, and every line
  carries the Agent that last changed it, which is what routes a review comment.
- **AEGIS** — a sandbox plane. Retained as defence in depth because fan-out makes
  workspace isolation a real requirement. **Not the claimed track.**

> The orchestrator holds **no** workspace authority, deliberately. An agent that
> can read every workspace is the single principal an attacker needs — the
> classic confused deputy. It splits, assigns and integrates, and nothing else.
