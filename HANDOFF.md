# HANDOFF

Written 2026-08-31 so a fresh session can pick this up without re-deriving it.
Read this first, then `docs/MASTER.md`.

## 1. Where the code is — read this before anything else

**Canonical working copy: `/home/jemy/tiktok/PleaseHireMe`.**

There is a second clone at `/home/jemy/PleaseHireMe`. It is **stale** — it sits
on the old `origin/main` and contains two abandoned branches. Everything in it
is superseded. Do not work there.

A previous session lost a day to this: it never ran `git fetch`, concluded that
WARRANT/CONCORD/AEGIS "did not exist", and rebuilt them from scratch in the
stale clone. **Run `git fetch --all` and check `git branch -a` before believing
anything about what is or is not implemented.**

## 2. State

| | |
| --- | --- |
| Branch | `main`, pushed |
| Tests | **328**, `npm run check` green (typecheck + tests + build) |
| Declared track | **B — The Bouncer**. Do not change it without the team. |
| Ark | configured and **live-verified** — a real turn returned a real answer |

Branches `feat/line-provenance` and `feat/blame-consult` are merged into `main`.

## 3. How to run it

```bash
npm install
npm run dev        # → http://localhost:5173, sidebar → Middleware console
```

That is the everyday setup. Codex runs in-process (`RUNTIME_PROVIDER=local-process`),
**no Docker needed**, and the chat works.

```bash
npm run check              # typecheck + 328 tests + build
npm run demo:warrant       # 10-beat Track B story, ~2s, no key or Docker
npm run poc                # full container POC — only for the AEGIS sandbox demo
```

Two traps, both fixed but worth knowing:

- **`.env` is the docker-compose file.** Its `APP_DATA_DIR` etc. are *container*
  paths (`/app/...`). `scripts/run-server.sh` exports host paths first and then
  lets Node parse `.env`; Node does not override already-set vars, which is the
  precedence we want. Do not simply `source .env` on the host.
- **`ARK_BASE_URL` is regional.** The key is international:
  `https://ark.ap-southeast.volces.com/api/v3`. The `cn-beijing` default returns
  **401**, and Codex reports it as a bare auth failure that mentions no region.

## 4. What was built recently (beyond the team's WARRANT/CONCORD/AEGIS)

All in `main`. Full design write-up: `docs/CONCORD_REVIEW_LOOP.md`.

1. **Line provenance** (`concord/provenance.ts`) — which Agent last changed each
   line, reconciled inside the commit critical section using CONCORD's existing
   `diffLines`. No new dependency. Invariant: one entry per canonical line.
2. **Agent checkpoint commits** (`concord/checkpoint.ts`) — the Agent names its
   own commit with `CONCORD-COMMIT: <message>`. One commit per turn, because
   CONCORD only observes turn boundaries; promising per-checkpoint commits would
   be a claim the middleware cannot keep.
3. **Review loop** (`review/`) — comment on lines, routed by provenance to the
   Agent that wrote them; consultation (explanation-only); re-iteration back
   through `store.write()`; blame endpoint. Comments become *addressed*, never
   *resolved* — only a human resolves.
4. **Console UI** — night mode (light/dark/system), IDE chrome (activity bar,
   tabs, bottom panel, status bar), per-line blame gutter, review panel.

## 5. Outstanding — read before demoing

### 5a. Code-review findings NOT yet fixed

A review of `main...HEAD` raised 15. Four were fixed (commit `5978fd0`). These
remain. **Most are in AEGIS and belong to its owner — do not rewrite AEGIS
without talking to them.**

| Where | Problem |
| --- | --- |
| `aegis/index.ts:21` | `writeCodexConfig` points at the broker whenever the broker started, *regardless of `runtimeProvider`*. With the defaults (`AEGIS_ENABLED=true`, `RUNTIME_PROVIDER=local-process`) the host Codex is aimed at `host.docker.internal:8788`, which does not resolve off Docker. **Suspected to break local turns; our live run worked, so verify before assuming.** |
| `aegis/egress/broker.ts:195` | Error handler calls `writeHead` after headers may already be sent → throws inside an `error` listener → **uncaught exception takes the whole server down**, not just one turn. |
| `aegis/egress/broker.ts:73` | `server.requestTimeout = 0` disables the timeout, the opposite of what the comment above it says. |
| `aegis/index.ts:270` | Broker binds `0.0.0.0`, exposing an Ark-shaped endpoint on every interface. MASTER R11 shows binding the network's bridge gateway gives the same reachability without the exposure. |
| `aegis/sandbox/network.ts:124` | `probeBroker` treats *any* HTTP response as healthy, so an unrelated process on :8788 makes the hardened profile report complete. |
| `app.ts:72` | `/api/concord/` and `/api/review/` are exempt from the shared token and authenticate on a caller-supplied `agentId`. `/api/warrant/tasks/:id` hands those ids out **unauthenticated**, so with `APP_AUTH_TOKEN` set a stranger can still write shared documents. **The most serious one.** |
| `concord/store.ts:300` | `conflictSeq` restores from the count of *open* conflicts, not the highest ever issued, so ids can collide after a restart and a human settles the wrong Agent's edit. |
| `concord/reconcile.ts:178` | `forget()` is never called; the checkouts map grows for the process lifetime. |
| `concord/routes.ts:144` | `{choice:"content", content:""}` is rejected by a falsy check — emptying a contested file is legitimate and should use `=== undefined`. |
| docs | Test counts disagree: `MASTER.md` says 324/255 in different places, README and THREAT_MODEL say 255. Actual is **328**. |

### 5b. Not verified

- **Nobody has looked at the UI in a browser.** It compiles, builds, and the
  API paths are exercised, but no human eye has seen night mode or the console.
  **Do this before demoing.**
- **No live Ark run of the review loop.** The chat path is live-verified; an
  Agent actually revising code through re-iteration, or answering a
  consultation, is still only tested against a stubbed runner. (`R12`)
- Consultations are in memory; comments, runs and events persist. (`R13`)

## 6. Work in progress, uncommitted

`apps/server/src/live/activity.ts` — a live Agent activity feed. Codex emits
JSONL and both runners already hand every line to `inspect` for AEGIS G3; this
taps the same stream, so what it shows genuinely happened. The AEGIS runner now
chains the caller's hook (after its own verdict, return value ignored) so an
observer cannot abort a run.

**Still to do:** publish from the `/run` route, an SSE endpoint, and a UI panel.

Deliberately excluded: character-level cursors. Codex reports items, not
keystrokes, so a cursor would be fabricated. Section-level presence is what the
backend actually knows.

## 7. The Instagram-reel scorecard, honestly

The build proves the hard half and not the theatrical half.

| Claim | Status |
| --- | --- |
| Agents don't overwrite each other | ✅ Three-way merge; overlap is a held conflict |
| Commit versions, who changed what | ✅ Checkpoint messages, per-line blame |
| Multiple agents at once | ✅ |
| Where each agent is working | ✅ Section-level, from Run state |
| Agents know what others built | ⚠️ Via the envelope, at **turn start** only |
| See agents typing live | ⚠️ Section 6 makes this real; not finished |
| Live cursors | ❌ Not built. Would be fake. |
| Teammates' prompts | ❌ Not built |

## 8. House rules

- One track: **B**. Extra tracks score nothing if the selected one is incomplete.
- `npm run check` must be green before pushing.
- Claim a `docs/MASTER.md` roadmap row before touching a shared module; add a
  changelog line; never delete a row.
- Do not weaken AEGIS or bypass CONCORD's write path.
- Never commit `.env`. It holds a live Ark key.
