# One file, many Agents — the v2 workspace

The pitch: git and an editor were built for one person at a time. Neither has
an answer for six Agents writing one file at once. This does.

Everything below is enforced by the middleware, not asserted by the interface.

---

## 1. What changed from v1

| v1 | v2 |
| --- | --- |
| Two mock humans, a sign-in switcher, "run anyway" | **One operator.** Warrants still delegate — from one human to N Agents |
| Split a task; every Agent could write anywhere | **Each Agent is allocated one section**, and CONCORD refuses a write outside it |
| Read-only viewer | **Monaco editor.** You type into the shared file; autosave goes *through* CONCORD |
| Type an Agent id to consult | **Confirm the Agent** provenance already identified — yes/no |
| One activity feed | **A live screen per Agent**, showing its real workspace copy as it changes on disk |
| No stop | **Stop mid-turn**, plus per-Agent run and an auto mode |
| No end state | **Merge gate**, open only when every Agent is approved and nothing is contested |

## 2. Section ownership — the core of it

`concord/sections.ts`. The orchestrator gives each subtask one heading, seeds
the document so every section exists, and registers the allocation. Then inside
CONCORD's write critical section:

```
allocation   who MAY change these lines      refused before commit
merge        what happens when two race      never a silent loss
lease        a temporary exclusive claim     unchanged
```

A document with **no** allocations is unrestricted, which is what leaves every
prior behaviour exactly as it was.

The check runs on the **diff**, not the payload — an Agent rewriting its own
section still hands back the whole file, so the question is what it *changed*.
Refusals are `denied`, not `conflict`: nothing is contested, the Agent simply
had no business there.

| Rule | When |
| --- | --- |
| `CD-section.outside` | the write changes a line outside the allocation |
| `CD-section.not-allocated` | the document allocates sections and this Agent holds none |
| `CD-section.missing` | the anchoring heading is gone — refuse rather than guess |

**The human is exempt**, deliberately. Allocations bind Agents to their assigned
work; the operator owns the whole file. It is also the only legitimate way an
anchor heading can move.

## 3. The human's own edits

`store.writeAsHuman()`. Three differences from an Agent write, each on purpose:

- **No warrant.** A warrant is a delegation *from* this human. Requiring one to
  edit their own document would be circular.
- **No section.** See above.
- **No merge.** A human edit is interactive: it applies to the revision they
  were looking at, or they are told it moved. Silently merging text somebody is
  still typing is worse than refusing it.

Provenance records the human and leaves `lastModifiedByAgentId` null — so the
review loop will not route a question about a hand-typed line at an Agent that
never wrote it.

## 4. The live screens

`live/workspace.ts` polls each Agent's workspace copy every 250ms during a turn
and publishes each new state over SSE. The text on screen appeared in the file,
at that moment, because the Agent put it there.

Polling rather than `fs.watch`: `fs.watch` is platform-dependent and fires
either twice or never on several WSL and container filesystems — which is
exactly where this runs. A 250ms `stat` is boring and portable.

Three decorations, each a fact:

- **the band** — the section CONCORD confines this Agent to. Everything else is
  dimmed, because it is not this Agent's to change.
- **the flash** — the region that just changed, from a real diff of two file
  states. It fades; it does not loop.
- **the peer strip** — what the other Agents own and what revision they are
  merged against, which is what "knows about the others" actually consists of.

**Still no fabricated caret.** Between two file states the runtime reports no
position, so drawing one would be animation. The changed region *is* the
position, and it is honest.

## 5. Monaco

Added deliberately, having been refused in v1. The reason changed: v1 had a
read-only viewer, where Monaco would have been weight for nothing. v2 has real
editing plus decorations carrying section ownership, blame and live edit
regions — hand-rolling that is more work than integrating it, and the pitch is
literally "an editor that was not built for this".

Trimmed to what the app opens. The package root registers ~80 languages plus
four language services and their workers:

| | entry chunk | total | chunks |
| --- | --- | --- | --- |
| default import | 4.2 MB | 15 MB | 95 |
| `monaco-editor/editor.js` + 6 grammars, lazy-loaded | **248 kB** | **3.3 MB** | **13** |

Two gotchas worth keeping: the exports map is `"./*.js": "./esm/vs/*.js"`, so
the once-standard `monaco-editor/esm/vs/...` deep path now resolves to
`esm/vs/esm/vs/...` and fails **at build time while the typecheck passes**; and
the loader fetches from a CDN unless pointed at the local package, which means
it silently never loads offline — the exact conditions a demo runs in.

## 6. AEGIS: five false positives, found by running it

The sandbox scans each Codex event line for paths and hosts. It is a heuristic
over shell text, and it was killing legitimate runs. Every fix below is a
**precision** fix — none relaxes what the policy intends to refuse.

| # | What died | Cause | Fix |
| --- | --- | --- | --- |
| 1 | every local turn | `WORKSPACE_MOUNT` is the *container* path; under `local-process` the Agent names host paths | the ticket carries the path the Agent sees, resolved per runtime |
| 2 | `find … -not -path '*/.git/*'` | the glob yielded a "path" `/.git` | a slash glued to anything does not begin an absolute path |
| 3 | writing a `.ts` file mentioning a URL | here-document **bodies** were scanned as commands | strip heredoc bodies; the redirect target survives |
| 4 | `sed 's/x/tests\/a.ts/'` | `\/` read as an absolute path | unescape first — which also *catches* `cat \/etc\/passwd`, previously missed |
| 5 | `./.agents/*`, `src'/'a.ts` | relative paths and shell-concatenated quotes | exclude path-name characters and wedged quotes from the lookbehind |

Fix 4 is worth noting: rejecting escaped slashes outright would have fixed the
false positive and **opened an evasion**. Unescaping first fixes both.

### Still open, and the owner's call

There is a **structural** issue behind all five. `fs.read` requests derived from
scanning shell text are enough to *kill a run*, and shell text cannot be parsed
reliably. A better shape is to record heuristic extractions and reserve
containment for `file_change` events, which Codex reports structurally — real
paths, no parsing. That is a policy design change and belongs to AEGIS's owner.

Until then, the prompts give Agents no reason to shell out (`apply_patch`, no
`find`/`sed`/`ls`, relative paths only), which is cheaper and more reliable than
widening the policy. Measured across four live three-Agent runs, blocked turns
went 2 → 3 → 1 → 0.

## 7. Verified live, and not

**Verified** against the real Ark endpoint on 2026-08-31:

- Three Agents planned, allocated a section each, and run in parallel by
  `autorun`. Two runs landed all three sections; the canonical file reached
  rev 4 with **zero conflicts**.
- Section enforcement over HTTP: a write inside the allocation is `written`, the
  same Agent reaching into a sibling's section is `403 CD-section.outside`, and
  canonical content does not move.
- Live workspace frames over SSE, carrying real changed ranges (`7–10`, `10–12`).
- Per-Agent token counts from real turns (36k, 90k, 119k input).
- Human autosave, stale rejection, and human-attributed provenance.
- AEGIS fix #1: an Agent naming its own workspace absolutely is now allowed,
  and one naming a sibling's is still refused.

**Not verified:**

- **Nobody has opened any of this in a browser.** It compiles, builds, and Vite
  serves every module, but no human eye has seen the layout. Do this first.
- A live model answering a **consultation** or revising through re-iteration.
- The hardened container profile with the live feed and the per-run workspace
  path attached.
- A three-of-three clean parallel run. The best measured is three sections
  filled with one Agent contained partway — its partial work still reconciled
  safely, which is the design working, but it is not the same thing.

## 8. A known flake, not introduced here

`aegis/guarded-runner.test.ts` fails roughly one full-suite run in eight, in
`KS-9 global kill switch` or the breaker tests, and passes in isolation every
time. The latch and breakers are process-global while the tests share one
`dir`, so ordering leaks between them. Pre-existing; AEGIS's owner should
decide whether to isolate the state or the temp directory.
