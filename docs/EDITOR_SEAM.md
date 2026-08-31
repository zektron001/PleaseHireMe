# The editor seam — human-in-the-loop editing

Who this is for: whoever is building human editing. The workbench and the Monaco
host are done and the editor is deliberately **read-only until you land**. This
is the contract, so you can drop an implementation in without touching the shell
and we do not end up with two write paths.

## Why the editor is read-only right now

`apps/web/src/editor/CodeEditor.tsx:166`

```ts
readOnly: readOnly || !onRequestSave,
```

`Console.tsx` passes `readOnly={false}` but no `onRequestSave`, so Monaco locks
itself. That is on purpose: an editor that lets someone type and then silently
drops the text is worse than one that will not let them type. The moment you
pass `onRequestSave`, it becomes editable and `Ctrl+S` works.

**`CodeEditor.tsx` makes no network call of any kind, and it should stay that
way.** Everything it can do to a document leaves through a prop.

## The contract

`apps/web/src/editor/CodeEditor.tsx`

```ts
onRequestSave?: (content: string, expectedVersion: number) => Promise<SaveOutcome>;

export type SaveOutcome =
  | { status: "written" | "merged"; version: number; content: string }
  | { status: "denied"; reason: string }
  | { status: "leased"; holder: string }
  | { status: "conflict"; conflictId: string };
```

`expectedVersion` is handed to you, not read by you — it is the revision the
buffer was based on, and it is the CAS token. Do not substitute a freshly
fetched version to "fix" a conflict; the conflict is the point.

## What to call

One endpoint. **Do not add a second write path** — `store.write()` is where
authority, ordering, merge and conflict all live, and it is checked inside the
critical section so a revocation landing mid-write is honoured.

```
POST /api/concord/docs/:docId
Authorization: Bearer <session token>
{ agentId, expectedVersion, content, message? }
```

- `agentId` — the signed-in human's own Agent. It is a **selector, not a
  credential**: `warrant/access.ts` 403s unless the session owns the subtask
  behind it. `Console.tsx` already derives this as `myAgent`.
- `message` — optional, one line, what the change is for. Without it the Source
  Control view can only title the commit "n lines changed". This is the human's
  equivalent of the Agent's `CONCORD-COMMIT:` checkpoint.

`api.ts` has no `writeDoc` yet — adding it is yours. Follow `resolveConflict`
just below `docHistory`; it uses the same `asHuman` wrapper.

## The status code IS the outcome

`concord/routes.ts:126-133` maps each outcome to the code that describes it, so
you never have to parse a message:

| Code | `outcome.status` | What the editor should do |
| --- | --- | --- |
| 200 | `written` | Clear dirty. Show the new revision. |
| 200 | `merged` | **`outcome.content` is not what was typed** — another Agent's independent edit was folded in. Apply it, clear dirty, and say so. |
| 403 | `denied` | Show `reason` and go read-only. Do not hide the button beforehand: the denial is the thing worth showing. |
| 409 | `conflict` | The canonical content did **not** move. Surface `conflictId` — only the owning human or the orchestrator may settle it, via `POST /api/concord/docs/:docId/resolve`. |
| 423 | `leased` | Locked by `holder`. `POST .../lease` and `DELETE .../lease` exist and are unused by any client. |

For `merged`, apply the returned content with `model.pushEditOperations`, not
`setValue` — `setValue` destroys undo history and the cursor. `CodeEditor`'s own
`save()` already does this; copy it.

## The one thing that does not exist yet

**There is no route to stop a subtask Agent mid-turn.** Roadmap `R20`,
unclaimed.

`POST /api/agents/:id/stop` is the *core* agent model (UUID, own workspace dir),
not the subtask model (`agent_<uuid>`, minted by planning). Wiring one to the
other would be a lie in the UI. What is needed:

```
POST /api/warrant/subtasks/:subtaskId/stop
```

owner-checked exactly like `/run` (`warrant/routes.ts:191-215`), returning the
subtask to `assigned` and publishing a `blocked` activity event. Until it lands,
render the Stop control disabled with a title saying why. Do not fake it —
`AMOEBA_INSPIRATION_SCOPE.md` §5 is explicit that inventing a button which does
nothing is the exact failure mode that document exists to prevent.

## Optional, if two humans will be on stage

The signed-in human typing genuinely has a character position, and unlike an
Agent's it is a real cursor rather than a commit marker. Publishing it needs one
small addition: accept `{ line, column }` on
`POST /api/concord/docs/:docId/presence` and pass it to `store.mark()`, which
already takes a caret. ~10 lines beside the existing GET at
`concord/routes.ts:189`. The rendering side already works — see
`caretDecorations` in `editor/decorations.ts`.

Skip it unless the demo has two humans editing at once.

## Checks

`npm run check` must stay green — 363 server tests, 8 web. Worth adding: a test
that a 409 leaves the canonical content unmoved, and one that a `merged` result
applies the server's content rather than the buffer's.
