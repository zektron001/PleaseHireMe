# Testing

Two lanes, because they answer two different questions. Run both.

```bash
npm run test:baseline   # "did I break something that used to work?"  -> must be green
npm run test:audit      # "what does this product do that its docs deny?" -> red on purpose
npm test                # everything, both lanes
```

## The baseline lane

The suites that existed before the audit. They cover the happy paths and the
unit behaviour of every subsystem, and they pass. Treat a failure here as a
regression you just introduced — nothing in this lane is a known defect.

## The audit lane

`*.contract.test.ts`, `*.property.test.ts`, `security.test.ts`, and
`client-contract.test.ts`, plus everything under `apps/web/src`.

**These fail on purpose.** Each failing test asserts something the developers'
own documentation claims, against code that does something else. The failure
message names the doc line it contradicts. Do not "fix" a test in this lane by
weakening its assertion — the assertion is a quote from `docs/`. Either the
code changes to match the doc, or the doc changes because it was wrong.

Three kinds of test live here:

- **Contract tests** (`*.contract.test.ts`) pin one written claim each. The file
  header quotes the claim and cites its source, e.g.
  `MIDDLEWARE_ARCHITECTURE.md:481` or the outcomes table in
  `CONCORD_REVIEW_LOOP.md:140`.
- **Property tests** (`*.property.test.ts`) use `fast-check` over the pure
  cores — the merge, the resource algebra, the policy decision function. Every
  property is seeded, so a failure reproduces exactly rather than depending on
  which seed the day gives you.
- **Adversarial tests** (`security.test.ts`) attack the running server through
  `app.inject`, driving the threat model's own attacker stories (AC-1..AC-12,
  T5, T7) rather than testing functions in isolation.

## Two tests that guard the suite itself

A test suite can fail for boring reasons and teach you nothing, so two tests
exist only to keep the others honest:

- `client-contract.test.ts` derives the browser's URL list from
  `apps/web/src/api.ts` and the server's route table from
  `apps/server/src/**.ts`, and cross-checks them. Neither list is hand-written,
  because a transcribed list goes stale the day someone adds route 41. It also
  ratchets the set of server routes no browser code calls: add a route and
  forget to wire it up, and it fails with the route's name.
- `security.test.ts`'s route census enumerates every registered route from
  source and probes each one with no credential. A route added tomorrow is
  covered without anyone remembering to add a test.

## Fuzzing

The property tests are the seam for it. They already generate inputs for
`concord/merge.ts`, `warrant/resources.ts`, and the AEGIS policy engine, so
raising `numRuns` or dropping the seed turns them into a fuzz run without
rewriting anything. The pure cores were chosen deliberately: they are total
functions over plain data, which is what fuzzes usefully.

## Running it from the repo root

`npm test` is the entry point, and `npx vitest` at the root now agrees with it.
Both work because `vitest.config.ts` at the root delegates to each workspace's
own config via `projects`. Without that delegation, a root-level vitest run
applies one config to the whole monorepo, the React tests under `apps/web` lose
`environment: "jsdom"`, and eleven passing tests fail with "document is not
defined" - a missing DOM that reads like a product bug. If you ever see a block
of `apps/web` component tests fail together, check which config was applied
before believing the failures.

## Notes

- CI (`.github/workflows/check.yml`) pins Node 22, because `engines` requires
  `>=22` and it is easy to develop on 20 without noticing.
- The audit lane runs in CI as a reporting job, not a blocking one, so the
  findings stay visible without wedging the build. Once the findings are
  closed, make it blocking — that is the point of the lane.
