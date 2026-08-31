# One-page architecture

One task is split into subtasks. Each subtask has **one accountable human** and
**one Agent acting for them** under a scoped, expiring, revocable *warrant*. The
backend decides every access; the browser decides none of them.

> **Rendered image:** [`docs/assets/architecture.png`](docs/assets/architecture.png)
> — the same page as a picture, for slides and anywhere Mermaid does not render.

```mermaid
flowchart TB
    subgraph L1["① UNTRUSTED — the browser decides nothing"]
        direction LR
        UI["<b>React workbench</b><br/>splits · runs · reviews · approves"]
        AG["<b>Agent process</b><br/>Codex CLI, one per subtask"]
    end

    UI -- "session token<br/><i>never a client-supplied id</i>" --> BOUND
    AG -- "tool calls" --> BOUND

    BOUND{{"<b>═══ TRUST BOUNDARY ═══</b><br/>Fastify + Zod validate shape.<br/>Identity comes from the token, never the payload."}}

    BOUND --> W
    BOUND --> C
    BOUND --> A

    subgraph L3["② POLICY PLANE — team-built middleware"]
        direction LR
        W["<b>WARRANT</b> · gate B.authz<br/>who may touch what<br/><i>WB-0 allow · WB-1/4/5/6/9 deny</i>"]
        C["<b>CONCORD</b> · gate C.concord<br/>many hands, one file<br/><i>CD-section.outside / .not-allocated</i>"]
        A["<b>AEGIS</b> · gates G1–G4<br/>what the runtime can reach<br/><i>KS-1 egress · KS-2 vault · KS-3 fs</i>"]
    end

    W -- "Allow" --> STORE
    C -- "serialised write<br/>+ provenance" --> STORE
    A -- "confines" --> WS

    subgraph L4["③ RUNTIME + DATA"]
        direction LR
        STORE[("<b>SharedDocStore</b><br/>revisions · per-line authorship")]
        WS[("<b>Per-subtask workspaces</b><br/>siblings exist at no path")]
        CHAIN[("<b>Audit chain</b><br/>prevHash → hash")]
    end

    W -. "every decision" .-> CHAIN
    C -. "every decision" .-> CHAIN
    A -. "every decision" .-> CHAIN

    STORE --> OUT
    CHAIN --> OUT
    WS --> OUT

    subgraph L5["④ BACK TO THE BROWSER"]
        direction LR
        OUT["<b>Live over SSE</b><br/>provenance · decisions · workspace frames"]
        DENY["<b>Refusal</b><br/>403 with the rule id<br/>that caused it"]
        RECOVER["<b>Recovery</b><br/>revoke a warrant mid-flight · stop a turn<br/>circuit breaker · conflict: ours / theirs / both"]
    end

    style L1 fill:#2a1717,stroke:#c8524a,color:#ffb3aa
    style L3 fill:#131f36,stroke:#4f8bf7,color:#a8c6ff
    style L4 fill:#102219,stroke:#3f9d6d,color:#8fdcb4
    style L5 fill:#1a1a24,stroke:#8b95a7,color:#c3ccdb

    classDef untrusted fill:#3a2020,stroke:#c8524a,color:#fff,stroke-width:1.5px
    classDef bound fill:#2b2410,stroke:#c9a227,color:#fff,stroke-width:2px
    classDef plane fill:#16233d,stroke:#4f8bf7,color:#fff,stroke-width:1.5px
    classDef data fill:#12271e,stroke:#3f9d6d,color:#fff,stroke-width:1.5px
    classDef out fill:#232532,stroke:#8b95a7,color:#fff,stroke-width:1.5px

    class UI,AG untrusted
    class BOUND bound
    class W,C,A plane
    class STORE,WS,CHAIN data
    class OUT,DENY,RECOVER out
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
  workspace isolation a real requirement.

> The orchestrator holds no workspace authority, deliberately. An agent that
> can read every workspace is the single principal an attacker needs — the
> classic confused deputy. It splits, assigns and integrates, and nothing else.
