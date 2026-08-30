# Threat model and safety controls

**CodeJam Track #5 · this repository implements the challenge's second recommended
middleware example: _Threat Modeling and Safety_.**

The brief asks a team choosing this direction to identify *protected assets, actors, trust
boundaries, abuse cases, implemented controls, and known residual risks*. Each has a section
below, and the seven threats from the brief's table are answered one by one in §5 with an
honest status per control — **implemented**, **partial**, or **not built**.

> **Read this first.** Roughly a third of the controls below are not implemented. They are
> listed anyway, marked, because a threat model that only lists what you happened to build
> is a marketing document. The gaps are the useful part.

| | |
| --- | --- |
| **Judged track** | B — The Bouncer. See [`WARRANT_TRACK_B.md`](WARRANT_TRACK_B.md). |
| **Retained, not claimed** | C — Kill Switch. See [`MIDDLEWARE_ARCHITECTURE.md`](MIDDLEWARE_ARCHITECTURE.md). |
| **Evidence** | `npm run check` — typecheck, 358 tests, build. |

---

## 1. Protected assets

| ID | Asset | Property at risk | Where it lives |
| --- | --- | --- | --- |
| **A1** | `ARK_API_KEY` | Confidentiality | Server env, runtime env |
| **A2** | Host filesystem outside a workspace | Confidentiality, Integrity | `/`, `$HOME`, the repo checkout |
| **A3** | Protected vault `vault/customers.db` | Confidentiality, Integrity | Host, outside every mount |
| **A4** | **Another owner's subtask workspace** | Confidentiality, Integrity | `workspaces/subtasks/<id>/` |
| **A5** | The shared integration branch | Integrity | `branch:integration` |
| **A6** | The decision log | Integrity, Confidentiality | `*-audit.jsonl` |
| **A7** | Ark quota and spend | Availability | Provider account |
| **A8** | Host network position | Confidentiality | Cloud metadata, RFC1918 |
| **A9** | A human's delegated authority | Integrity | The `Warrant` record |

**A4 and A9 are what make this fan-out platform different.** A single-agent platform has no
concept of "another owner's work", and no delegation to forge.

## 2. Actors and trust

| Actor | Trust | Note |
| --- | --- | --- |
| Human principal (`alice`, `bob`) | Semi-trusted | Authenticated by session token. Mock sign-in — see RR-1. |
| Orchestrator principal | Semi-trusted | May split, assign and integrate. Holds **no** workspace authority. |
| Agent principal | **Untrusted** | Exists only as a derivation of a warrant. |
| Prompt author | **Hostile** | Assumed attacker-controlled; that is what prompt injection means. |
| Model output | **Untrusted data** | An input to the platform, never an instruction to it. |
| Runtime container | **Untrusted code** | Executes attacker-influenced commands by design. |

## 3. Trust boundaries

| ID | Boundary | Enforced by | Strength |
| --- | --- | --- | --- |
| **TB-0** | Browser ↔ control plane | Session token; shared demo token for baseline routes | Weak — mock sign-in |
| **TB-1** | Caller ↔ policy plane | The PDP is the sole authority; identity only from a token | Structural |
| **TB-2** | Host ↔ runtime container | Namespaces, seccomp, cgroups, dropped caps, read-only rootfs | **Primary** |
| **TB-3** | Container ↔ network | Confined network mode | **Partial — broker not built** |
| **TB-4** | Container ↔ filesystem | One workspace bound; vault never mounted | **Primary** |
| **TB-5** | Agent ↔ another owner's work | `WB-6` **and** the absence of a bind mount | **Primary, doubled** |
| **TB-6** | Codex event stream ↔ control plane | Parsed as untrusted data | **Detective only** |

### The assertion the whole design rests on

> **The Codex event stream is not a security boundary.**

It is *self-reported by the model*. An injected model can narrate a benign action while
doing something else, or narrate nothing. So stream interception (G3) is **detective** —
fast containment and precise attribution — and prevention lives in TB-2, TB-4 and TB-5,
which the model cannot talk its way past.

## 4. Abuse cases

| ID | Abuse case | Threat | Status |
| --- | --- | --- | --- |
| **AC-1** | Read `/etc/passwd`, `~/.ssh/id_rsa`, the repo checkout | T4 | Denied — `KS-3` |
| **AC-2** | Destroy or mutate the protected vault | T4 | Denied — `KS-2`, detected by `KS-5` |
| **AC-3** | Read the vault, POST it offsite | T5 | Vault unreachable; egress **partial** |
| **AC-4** | SSRF to cloud metadata for instance credentials | T5 | Denied — `KS-1` private-range rules |
| **AC-5** | Print `$ARK_API_KEY` into the transcript | T1 | Redacted — `KS-8` |
| **AC-6** | Fork bomb, infinite loop, token burn | T6 | Denied — budget, max steps, concurrency |
| **AC-7** | **Alice's Agent reads Bob's workspace** | T5 | **Denied twice — `WB-6` and no bind mount** |
| **AC-8** | **Forge a user id to act as someone else** | T2 | **Structurally impossible** |
| **AC-9** | **Use a revoked or expired warrant** | T2 | Denied — `WB-2`, `WB-3`; no container is built |
| **AC-10** | **Approve or integrate work you do not own** | T2 | Denied — `WB-8`, `WB-9` |
| **AC-11** | Tamper with the decision log | T7 | Detected — hash chain |
| **AC-12** | **Read the decision log without authorisation** | T7 | Denied — session required, viewer-scoped |

## 5. The seven threats, answered

Statuses are deliberately conservative: **implemented** means there is a passing test.

### T1 · Credential theft or exposure

| Control from the brief | Status | Where |
| --- | --- | --- |
| Redaction from logs and traces | **Implemented** | `aegis/redact.ts`; sentinel-key test across every sink |
| Exclusion of secrets from source | **Implemented** | `.env`/`vault/` gitignored; no key in any committed file |
| Exclusion from browser state | **Implemented** | The Ark key never leaves the server; the UI never receives it |
| Managed secret references | **Not built** | Key is read from the process env |
| Short-lived credentials | **Partial** | A per-run token is minted and injected, but nothing consumes it yet |
| Rotation | **Not built** | Requires a restart |

### T2 · Privilege escalation or confused delegation — *the judged track*

| Control | Status | Where |
| --- | --- | --- |
| Least-privilege scopes | **Implemented** | `WarrantScope`; `WB-4` denies an ungranted scope |
| Explicit delegation | **Implemented** | The `Warrant` record; no ambient authority exists |
| Backend policy checks | **Implemented** | Pure PDP; every route calls it |
| Approvals | **Implemented** | `WB-8` — the orchestrator cannot merge unapproved work |
| Revocation | **Implemented** | `WB-2`; a revoked warrant also yields **no container** |
| Complete actor attribution | **Implemented** | Five-tuple on every decision |
| Time-bound delegation | **Implemented** | `expiresAt`, `WB-3` |
| Sub-delegation with attenuation | **Not built** | An Agent cannot delegate onward — see RR-4 |

> The confused-deputy defence worth naming: **the orchestrator holds no workspace
> authority.** A "daddy agent" that could read every workspace would become the single
> principal an attacker needs.

### T3 · Prompt injection or tool misuse

| Control | Status | Where |
| --- | --- | --- |
| Typed schemas | **Implemented** | Zod on every route |
| Target-resource scoping | **Implemented** | Rules are over canonical actions and resources, never prompt keywords |
| Execution limits | **Implemented** | Timeout, output cap, max steps |
| Tool allowlists | **Partial** | Commands are inspected; there is no positive allowlist of binaries |
| Output validation | **Partial** | Events are parsed defensively; content is not schema-validated |
| Approval for high-risk actions | **Not built** | Approval exists for *merges*, not per-action |

> No rule anywhere matches a prompt keyword. §3 of the brief is explicit that a keyword
> filter is not sufficient, and a filter would also be trivially evaded.

### T4 · Sandbox escape or untrusted code

| Control | Status | Where |
| --- | --- | --- |
| Non-privileged execution | **Implemented** *(baseline)* | `--user`, `--cap-drop ALL`, `no-new-privileges` |
| Restricted filesystem | **Implemented** | One workspace bound; `codex-home` read-only; read-only rootfs |
| Controlled mounts | **Implemented** | `assertWorkspaceIsolation` blocks three distinct escapes |
| Resource limits | **Implemented** *(baseline)* | CPU, memory, PIDs |
| Restricted network | **Partial** | Confined mode emitted; the broker that makes it usable is **not built** |
| Patched runtime images | **Not built** | Codex version is pinned; no scanning or rebuild policy |

### T5 · Cross-user access or data exfiltration

| Control | Status | Where |
| --- | --- | --- |
| Ownership-aware authorization | **Implemented** | `WB-6.cross-owner-denied` |
| Storage isolation | **Implemented** | One directory per subtask; siblings never mounted |
| Scoped queries | **Implemented** | The decision log is filtered to the viewer |
| Protected metadata endpoints | **Implemented** | Link-local and CGNAT ranges denied, incl. `100.96.0.96` |
| Negative tests | **Implemented** | Every denial has a test; 13 of them are isolation tests |
| Outbound allowlists | **Partial** | Rules exist; topological enforcement awaits the broker |

### T6 · Runaway execution or cost

| Control | Status | Where |
| --- | --- | --- |
| Timeouts | **Implemented** *(baseline)* | `CODEX_TIMEOUT_MS` |
| Token / cost budgets | **Implemented** | Reserve-then-settle ledger, per-Agent and per-tenant |
| Quotas | **Implemented** | `KS-6.budget.exhausted` refuses before any spend |
| Maximum steps | **Implemented** | `AEGIS_MAX_STEPS`, enforced in the event stream |
| Concurrency limits | **Implemented** | `AEGIS_MAX_CONCURRENT_RUNS`, refused before a container exists |
| Administrative stop | **Implemented** | Global kill latch + per-Agent breaker + forced reap |

### T7 · Sensitive trace capture

| Control | Status | Where |
| --- | --- | --- |
| Redaction before export | **Implemented** | Applied once at the boundary, before any sink |
| **Trace access control** | **Implemented** | `/api/warrant/events` requires a session; ordinary humans see only their own decisions |
| Configurable capture levels | **Implemented** | `AEGIS_CAPTURE_LEVEL` — at `minimal` no evidence payload is written at all |
| Retention limits | **Implemented** | `AEGIS_RETENTION_MAX_EVENTS`, `AEGIS_RETENTION_MAX_AGE_MS` |

> **Retention and tamper-evidence are in tension.** Pruning record *i* breaks a chain
> verified from genesis. The log therefore keeps an **anchor** — the hash of the last pruned
> record — and verifies exactly over the retained window, so a gap is explicit rather than
> an unexplained verification failure.

## 6. Residual risks

| ID | Risk | Why it remains | Compensating control | Production path |
| --- | --- | --- | --- | --- |
| **RR-1** | **Human sign-in is mock.** Anyone who can reach the server can be `alice`. | §8 permits mock users; the judged property is what happens *after* delegation. | Loopback binding; shared token for baseline routes | OIDC / Volcengine IAM |
| **RR-2** | **Egress confinement is credential-based, not topological.** The broker is built: the container holds a per-run capability rather than the Ark key, and every crossing is recorded. But the network is a dedicated bridge, not `--internal`, so the Agent could still *reach* other hosts - it simply has no credential worth taking there, and no way to obtain one. | Measured, not assumed: on an `--internal` network the container reaches nothing at all, the host broker included (`ENETUNREACH`), so a host-process broker cannot serve one. | Capability dies with the run; key never enters the namespace; `KS-1` rules still deny at G3 | R11 - run the broker as a container attached to both the internal network and a routable one, then turn on `--internal` |
| ~~**RR-3**~~ | **Closed.** A real Codex turn runs under the full profile - dedicated network, read-only rootfs, seccomp, pinned config, no key in the namespace - and CONCORD commits its edit. Three blockers were found by trying it: the network was never created (exit 125), KS-3's blanket read-only home stopped Codex writing its own sessions, and KS-7 had nothing to hand the key to. | argv-level tests could not see any of them: `--network aegis-egress` looks identical whether or not that network exists | 13 argv-level tests, 9 broker tests, and a live hardened run | |
| **RR-4** | Container escape via kernel 0-day | Namespaces share one kernel | seccomp, cap-drop, read-only rootfs | gVisor, Kata, Firecracker, veFaaS |
| **RR-5** | Semantic exfiltration inside a legitimate Ark request | Ark must stay reachable | Egress volume cap | DLP at the broker |
| **RR-6** | Self-reported event stream (TB-6) | The model narrates its own actions | Prevention never depends on it | eBPF/auditd from outside the namespace |
| **RR-7** | Audit chain is tamper-**evident**, not tamper-resistant | Host root can rewrite it | Chain outside all mounts | Remote WORM storage |
| **RR-8** | In-memory registry | Warrants do not survive a restart | Matches the baseline store | Postgres with row-level security |
| **RR-9** | No sub-delegation | Deliberate; depth needs attenuation to stay safe | — | Macaroon-style caveats |

## 7. What a reviewer should check

```bash
npm run check          # typecheck + 358 tests + build
npm run demo:warrant   # the delegation story, 9 beats, no Ark key needed
```

| Claim | How to falsify it |
| --- | --- |
| Cross-owner access is denied | `warrant/scenario.test.ts` → `WB-6.cross-owner-denied`, HTTP 403 |
| …and is denied *physically* | `warrant/isolation.test.ts` → no sibling path in the generated argv |
| A forged user id changes nothing | Attack via query, two headers and body at once; caller stays `alice` |
| Revocation is immediate | The same read that passed now returns `WB-2.warrant-revoked` |
| The decision log is not public | Unauthenticated `GET /api/warrant/events` → 401 |
| Secrets never reach a sink | Sentinel key asserted absent from store, events, logs, HTTP bodies |
| The chain detects tampering | Edit one event; the verifier names its index |

---

<sub>Threat model · Volc Agent Launchpad · CodeJam Track #5 v2 · judged track B, retained track C</sub>
