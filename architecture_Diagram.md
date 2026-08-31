# Architecture Diagram

Volc Agent Launchpad + **WARRANT**. Diagrams are Mermaid, so they render
directly on GitHub with no toolchain. A LaTeX/TikZ source for the main diagram
is in [appendix A](#appendix-a--latex--tikz-source) if you need a PDF or a
slide.

---

## 1. System context

Everything the browser asks for passes the **PDP** before it reaches data.

```mermaid
flowchart TB
    subgraph browser["Browser"]
        UI["React Web UI<br/><small>Vite · Monaco editor</small>"]
    end

    subgraph node["Node process — single control plane"]
        API["Fastify API<br/><small>validation · CORS · static</small>"]

        subgraph planes["Middleware planes"]
            PDP["<b>WARRANT</b> PDP<br/><small>Track B — judged</small>"]
            CONCORD["<b>CONCORD</b><br/><small>shared documents</small>"]
            REVIEW["<b>REVIEW</b><br/><small>comments · consultations</small>"]
            LIVE["<b>LIVE</b><br/><small>activity · streams</small>"]
            PEP["<b>AEGIS</b> PEP<br/><small>Track C — retained</small>"]
        end

        SVC["AgentService<br/><small>lifecycle · one run per agent</small>"]
        STORE[("JsonStore<br/><small>launchpad.json</small>")]
        WS[("Workspaces<br/><small>one dir per agent</small>")]
        RUNNER{"runner-factory"}
    end

    subgraph exec["Execution"]
        PROC["Codex child process<br/><small>local-process</small>"]
        CONT["Disposable container<br/><small>container</small>"]
    end

    ARK["Volcengine Ark<br/><small>Responses API</small>"]

    UI -->|"/api/*"| API
    API --> PDP
    API --> CONCORD
    API --> REVIEW
    API --> LIVE
    CONCORD -.->|authorised by| PDP
    REVIEW  -.->|authorised by| PDP
    LIVE    -.->|authorised by| PDP
    PDP --> SVC
    SVC --> STORE
    SVC --> WS
    SVC --> PEP
    PEP --> RUNNER
    RUNNER -->|RUNTIME_PROVIDER| PROC
    RUNNER -->|RUNTIME_PROVIDER| CONT
    PROC --> ARK
    CONT -->|egress broker| ARK

    classDef judged fill:#0f766e,stroke:#134e4a,color:#fff
    classDef retained fill:#475569,stroke:#1e293b,color:#fff
    classDef ext fill:#7c2d12,stroke:#431407,color:#fff
    class PDP judged
    class PEP retained
    class ARK ext
```

**The key line:** the browser never decides an authorization question, and it
never sees the Ark API key.

---

## 2. A warranted run, end to end

The positive path and the denial, side by side — this is the core of Track B.

```mermaid
sequenceDiagram
    autonumber
    actor Alice
    participant API as Fastify API
    participant PDP as WARRANT PDP
    participant SVC as AgentService
    participant FS as Workspace
    participant CX as Codex
    participant ARK as Ark

    Alice->>API: POST /api/warrant/session
    API-->>Alice: session token
    Note over API,PDP: identity is derived from the token<br/>and from nothing else

    Alice->>API: POST /api/warrant/tasks (split)
    API->>PDP: mint one warrant per subtask
    PDP-->>API: scopes · resources · expiry

    rect rgb(220, 245, 235)
        Note over Alice,ARK: POSITIVE — inside the warrant
        Alice->>API: POST /api/warrant/subtasks/:id/run
        API->>PDP: authorize(agent, workspace.write, res)
        PDP-->>API: PERMIT
        API->>SVC: start run
        SVC->>FS: bind only the warranted directory
        SVC->>CX: codex exec --sandbox workspace-write
        CX->>ARK: Responses API
        ARK-->>CX: completion
        CX-->>SVC: result
        SVC-->>Alice: run succeeded
    end

    rect rgb(253, 226, 226)
        Note over Alice,FS: DENIAL — reaching for Bob's workspace
        Alice->>API: read resource owned by bob
        API->>PDP: authorize(agent, workspace.read, bob-res)
        PDP-->>API: DENY · WB-6.cross-owner-denied
        API-->>Alice: 403
        Note over FS: and physically: Bob's files are<br/>at no path in this namespace
    end

    rect rgb(254, 243, 199)
        Note over Alice,PDP: REVOCATION — mid-flight
        Alice->>API: POST /api/warrant/revoke
        API->>PDP: revoke(warrantId)
        Alice->>API: next agent action
        API->>PDP: authorize(...)
        PDP-->>API: DENY — no live warrant
        Note over SVC: no container is built
    end
```

---

## 3. Subtask state machine

```mermaid
stateDiagram-v2
    [*] --> assigned: orchestrator splits the task
    assigned --> in_progress: agent starts under its warrant
    in_progress --> submitted: agent proposes work
    submitted --> approved: the OWNING human approves
    approved --> integrated: orchestrator merges
    integrated --> [*]

    in_progress --> blocked: warrant revoked or expired
    submitted --> blocked: owner rejects
    blocked --> assigned: reassigned to a new owner + agent

    note right of approved
        The integration gate refuses
        to merge any task whose
        subtasks are not all approved
    end note
```

---

## 4. The authorization decision

Every `/api/*` call that touches data resolves through one path. There is no
ambient permission and no second way in.

```mermaid
flowchart LR
    REQ["Request"] --> TOK{"valid session<br/>token?"}
    TOK -->|no| D1["401"]
    TOK -->|yes| WHO["principal := token.humanId<br/><small>query · headers · body ignored</small>"]
    WHO --> W{"live warrant<br/>for this agent?"}
    W -->|no| D2["403 · no live warrant"]
    W -->|expired / revoked| D3["403 · not live"]
    W -->|yes| S{"action within<br/>warrant scopes?"}
    S -->|no| D4["403 · scope"]
    S -->|yes| R{"resource in<br/>warrant.resources?"}
    R -->|no| D5["403 · cross-owner"]
    R -->|yes| P["PERMIT<br/><small>appended to the audit chain</small>"]

    classDef deny fill:#7f1d1d,stroke:#450a0a,color:#fff
    classDef ok fill:#14532d,stroke:#052e16,color:#fff
    class D1,D2,D3,D4,D5 deny
    class P ok
```

**The success test:** changing the user id in the request — query param, header,
or body field — cannot bypass this, because `principal` is taken from the
session token before any of them are read.

---

## 5. Runtime topology

The same control plane, two execution modes, selected by `RUNTIME_PROVIDER`.

```mermaid
flowchart TB
    subgraph lp["RUNTIME_PROVIDER=local-process"]
        direction TB
        S1["Fastify server"] --> C1["codex child process"]
        C1 -->|"direct · ARK_BASE_URL"| A1["Ark"]
        N1["AEGIS_ENABLED=false<br/><small>the broker mints capabilities<br/>for container runs only</small>"]
    end

    subgraph ct["RUNTIME_PROVIDER=container (docker compose)"]
        direction TB
        S2["Fastify server"] --> C2["disposable runtime container<br/><small>seccomp · cpu · memory · pids</small>"]
        C2 -->|"per-run capability"| B2["AEGIS egress broker<br/><small>:8788</small>"]
        B2 --> A2["Ark"]
        V2[("vault/")] -.-> B2
    end

    classDef warn fill:#78350f,stroke:#451a03,color:#fff
    class N1 warn
```

| | local-process | container |
|---|---|---|
| Isolation | OS process, `--sandbox workspace-write` | namespace + seccomp + cgroup limits |
| Egress | direct to `ARK_BASE_URL` | mediated by the AEGIS broker |
| Sibling workspaces | not mounted | exist at no path in the namespace |
| Aegis | must be **off** outside Compose | on |

---

## 6. Component map

| Path | Plane | Responsibility |
|---|---|---|
| `apps/web/src/` | — | React UI: agents, console, code editor, review, collab |
| `apps/server/src/app.ts` | — | Route registration, CORS, bearer check, static serving |
| `apps/server/src/agent-service.ts` | — | Agent lifecycle, one active run per agent |
| `apps/server/src/store.ts` | — | `JsonStore` — serialised writes, atomic replace, single process |
| `apps/server/src/runner-factory.ts` | — | Chooses `codex-runner` or `container-codex-runner` |
| `apps/server/src/warrant/` | **WARRANT** | PDP, registry, orchestrator, splitter, model policy, sharing, binding |
| `apps/server/src/concord/` | CONCORD | sections, three-way merge, reconcile, checkpoint, provenance |
| `apps/server/src/review/` | REVIEW | comments, consultations, reiterations |
| `apps/server/src/live/` | LIVE | activity feed, workspace streams, board |
| `apps/server/src/aegis/` | AEGIS | policy engine, egress broker, seccomp, ledger, breaker, attestation |

### Agent lifecycle

```
ready ──▶ busy ──▶ ready
  │         │
  ▼         ▼
stopped   error
```

Runs interrupted by a restart become `cancelled`.

---

## Appendix A — LaTeX / TikZ source

For a PDF or slide version of §1. Compile with `pdflatex` (needs
`tikz` + `positioning` + `fit`).

```latex
\documentclass[border=12pt]{standalone}
\usepackage{tikz}
\usetikzlibrary{arrows.meta, positioning, fit, backgrounds}

\begin{document}
\begin{tikzpicture}[
  font=\sffamily\small,
  node distance=9mm and 14mm,
  box/.style   = {rectangle, rounded corners=2pt, draw=black!55,
                  fill=white, minimum height=9mm, minimum width=30mm,
                  align=center},
  judged/.style= {box, fill=teal!75!black, text=white, draw=teal!40!black},
  retain/.style= {box, fill=black!55, text=white, draw=black!75},
  ext/.style   = {box, fill=orange!80!black, text=white, draw=orange!45!black},
  store/.style = {box, cylinder, shape border rotate=90, aspect=0.20},
  flow/.style  = {-{Stealth[length=2mm]}, draw=black!65},
  dash/.style  = {flow, dashed}
]

\node[box]    (ui)    {React Web UI};
\node[box, below=of ui] (api) {Fastify API};

\node[judged, below=of api]            (pdp)     {WARRANT PDP\\\scriptsize Track B};
\node[box,   left=of pdp]              (concord) {CONCORD\\\scriptsize documents};
\node[box,   right=of pdp]             (live)    {REVIEW / LIVE};

\node[box,    below=of pdp]  (svc)  {AgentService};
\node[store,  left=of svc]   (db)   {JsonStore};
\node[store,  right=of svc]  (wsp)  {Workspaces};

\node[retain, below=of svc]  (pep)  {AEGIS PEP\\\scriptsize Track C};
\node[box,    below=of pep]  (run)  {runner-factory};
\node[box,    below left=of run]  (proc) {codex process};
\node[box,    below right=of run] (cont) {container};
\node[ext,    below=18mm of run]  (ark)  {Volcengine Ark};

\draw[flow] (ui)  -- node[right,font=\scriptsize]{/api/*} (api);
\draw[flow] (api) -- (pdp);
\draw[flow] (api) -| (concord);
\draw[flow] (api) -| (live);
\draw[dash] (concord) -- node[above,font=\scriptsize]{authorised by} (pdp);
\draw[dash] (live)    -- node[above,font=\scriptsize]{authorised by} (pdp);
\draw[flow] (pdp) -- (svc);
\draw[flow] (svc) -- (db);
\draw[flow] (svc) -- (wsp);
\draw[flow] (svc) -- (pep);
\draw[flow] (pep) -- (run);
\draw[flow] (run) -- (proc);
\draw[flow] (run) -- (cont);
\draw[flow] (proc) -- (ark);
\draw[flow] (cont) -- node[right,font=\scriptsize]{broker} (ark);

\begin{scope}[on background layer]
  \node[draw=black!25, dashed, rounded corners, fit=(pdp)(concord)(live),
        label={[font=\scriptsize\itshape]above right:middleware planes}] {};
\end{scope}
\end{tikzpicture}
\end{document}
```

---

**Related:** [`marcel anjing.md`](marcel%20anjing.md) (workflow) ·
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/MIDDLEWARE_ARCHITECTURE.md`](docs/MIDDLEWARE_ARCHITECTURE.md) ·
[`docs/WARRANT_TRACK_B.md`](docs/WARRANT_TRACK_B.md)
