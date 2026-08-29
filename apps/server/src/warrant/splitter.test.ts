import { describe, expect, it } from "vitest";
import { parseArkProposals, RuleSplitter } from "./splitter.js";
import { selectTier, selectModel, tiersFrom } from "./model-policy.js";
import { covers, normalisePath, repoFileResource } from "./resources.js";

describe("RuleSplitter", () => {
  it("produces non-overlapping paths", async () => {
    const proposals = await new RuleSplitter().split("Add rate limiting", 4);
    const paths = proposals.flatMap((p) => p.paths);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("respects the requested maximum", async () => {
    expect(await new RuleSplitter().split("x", 2)).toHaveLength(2);
    expect(await new RuleSplitter().split("x", 99)).toHaveLength(4);
    expect(await new RuleSplitter().split("x", 0)).toHaveLength(1);
  });
});

describe("parseArkProposals", () => {
  const wrap = (text: string) => ({ output_text: text });

  it("reads a clean JSON array", () => {
    const out = parseArkProposals(
      wrap(
        JSON.stringify([
          { title: "A", description: "da", paths: ["src/a.ts"] },
          { title: "B", description: "db", paths: ["src/b.ts"] },
        ]),
      ),
      5,
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.paths).toEqual(["src/a.ts"]);
  });

  it("tolerates prose and a code fence around the array", () => {
    const out = parseArkProposals(
      wrap('Sure!\n```json\n[{"title":"A","paths":["src/a.ts"]}]\n```\nHope that helps.'),
      5,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe("A");
  });

  it("drops a later subtask that claims an already-taken file", () => {
    // Two owners on one file is exactly the merge conflict the fan-out avoids.
    const out = parseArkProposals(
      wrap(
        JSON.stringify([
          { title: "A", paths: ["src/shared.ts"] },
          { title: "B", paths: ["src/shared.ts"] },
          { title: "C", paths: ["src/c.ts"] },
        ]),
      ),
      5,
    );
    expect(out.map((p) => p.title)).toEqual(["A", "C"]);
  });

  it("normalises traversal out of proposed paths", () => {
    const out = parseArkProposals(
      wrap(JSON.stringify([{ title: "A", paths: ["../../etc/passwd"] }])),
      5,
    );
    expect(out[0]?.paths).toEqual(["etc/passwd"]);
  });

  it("returns nothing it cannot trust, so the caller falls back", () => {
    expect(parseArkProposals(wrap("no json here"), 5)).toEqual([]);
    expect(parseArkProposals(wrap("[not valid json"), 5)).toEqual([]);
    expect(parseArkProposals(wrap(JSON.stringify({ nope: 1 })), 5)).toEqual([]);
    expect(parseArkProposals(null, 5)).toEqual([]);
    expect(parseArkProposals(wrap(JSON.stringify([{ paths: ["a"] }])), 5)).toEqual([]);
  });

  it("honours the maximum", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      title: "T" + i,
      paths: ["src/f" + i + ".ts"],
    }));
    expect(parseArkProposals(wrap(JSON.stringify(many)), 3)).toHaveLength(3);
  });
});

describe("model routing", () => {
  const tiers = tiersFrom("ep-base", { deep: "ep-deep", fast: "ep-fast" });

  it("routes trivial documentation work to the fast tier", () => {
    expect(
      selectTier({
        title: "Update the README",
        description: "Fix a typo",
        pathCount: 1,
        dependencyCount: 0,
      }),
    ).toBe("fast");
  });

  it("routes security and architecture work to the deep tier", () => {
    expect(
      selectTier({
        title: "Refactor the auth boundary",
        description: "security review",
        pathCount: 2,
        dependencyCount: 0,
      }),
    ).toBe("deep");
  });

  it("routes a blocking subtask to the deep tier", () => {
    expect(
      selectTier({
        title: "Implement the limiter",
        description: "core work",
        pathCount: 1,
        dependencyCount: 2,
      }),
    ).toBe("deep");
  });

  it("defaults to balanced", () => {
    expect(
      selectTier({
        title: "Add a config flag",
        description: "small change",
        pathCount: 1,
        dependencyCount: 0,
      }),
    ).toBe("balanced");
  });

  it("maps a tier to the configured endpoint", () => {
    expect(
      selectModel(
        { title: "typo in readme", description: "", pathCount: 1, dependencyCount: 0 },
        tiers,
      ),
    ).toBe("ep-fast");
    expect(
      selectModel(
        { title: "Add a flag", description: "", pathCount: 1, dependencyCount: 0 },
        tiers,
      ),
    ).toBe("ep-base");
  });
});

describe("resource canonicalisation", () => {
  it("resolves traversal and strips leading slashes", () => {
    expect(normalisePath("/src/../etc/passwd")).toBe("etc/passwd");
    expect(normalisePath("src//a/./b.ts")).toBe("src/a/b.ts");
  });

  it("covers by prefix without matching a sibling by accident", () => {
    const granted = repoFileResource("src/api");
    expect(covers(granted, repoFileResource("src/api/routes.ts"))).toBe(true);
    expect(covers(granted, repoFileResource("src/api"))).toBe(true);
    expect(covers(granted, repoFileResource("src/apikeys.ts"))).toBe(false);
  });

  it("treats workspace grants as exact", () => {
    expect(covers("ws:sub_1", "ws:sub_1")).toBe(true);
    expect(covers("ws:sub_1", "ws:sub_10")).toBe(false);
  });
});
