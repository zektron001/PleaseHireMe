import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { props } from "../testing/fuzz.js";
import { covers, normalisePath, REPO_PREFIX } from "./resources.js";

/**
 * Property suite for the pure resource-canonicalisation core (resources.ts's
 * module doc: "Authorization is decided over these strings and nothing else.
 * Keeping them canonical and total is what stops 'did you mean ws:sub-1 or
 * ws:sub-01?' from becoming a security bug.").
 */


/** A single legitimate path segment: no "/" or "\" (those are separators,
 * not segment content), and not one of the two segments normalisePath
 * treats specially ("." and ".."). */
const segmentArb = fc
  .string({ minLength: 1 })
  .filter((s) => !s.includes("/") && !s.includes("\\") && s !== "." && s !== "..");

const segmentsArb = (minLength = 0, maxLength = 8) => fc.array(segmentArb, { minLength, maxLength });

describe("normalisePath is idempotent", () => {
  /**
   * normalisePath.ts doc: "Strips leading slashes and resolves `..`, so no
   * path can escape sideways." A function that strips/resolves should reach
   * a fixed point on its own output — running it twice must equal running
   * it once, or callers who normalise defensively at two different layers
   * (e.g. once at the HTTP boundary, once again when building a resource id)
   * could silently get a different resource the second time.
   */
  it("normalisePath(normalisePath(x)) === normalisePath(x) for arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (x) => {
        const once = normalisePath(x);
        const twice = normalisePath(once);
        expect(twice).toBe(once);
      }),
      props(2001),
    );
  });
});

describe("normalisePath output shape", () => {
  /**
   * "no path can escape sideways" implies the output can never itself
   * contain the very tokens normalisePath exists to strip: "..", ".", or an
   * empty segment (which is what a leading/doubled "/" would produce), and
   * can never start with "/" (that would make it look absolute).
   */
  it("output never contains '..', '.', or an empty segment", () => {
    fc.assert(
      fc.property(fc.string(), (x) => {
        const result = normalisePath(x);
        const segments = result === "" ? [] : result.split("/");
        for (const seg of segments) {
          expect(seg).not.toBe("..");
          expect(seg).not.toBe(".");
          expect(seg).not.toBe("");
        }
      }),
      props(2002),
    );
  });

  it("output never has a leading slash", () => {
    fc.assert(
      fc.property(fc.string(), (x) => {
        expect(normalisePath(x).startsWith("/")).toBe(false);
      }),
      props(2003),
    );
  });
});

describe("normalisePath never escapes upward", () => {
  /**
   * The doc comment's whole point: "so no path can escape sideways." The
   * sharpest version of that claim is an excess of ".." climbs past the
   * root of a relative path — out.pop() (resources.ts:31) on an empty
   * array is a documented-by-behaviour no-op, never a negative-length
   * result and never a literal ".." surviving into the output.
   */
  it("a leading run of '..' segments (more than the path is deep) is absorbed, not carried through", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), segmentsArb(0, 6), (climbCount, tail) => {
        const climbs = Array.from({ length: climbCount }, () => "..");
        const input = [...climbs, ...tail].join("/");
        const result = normalisePath(input);
        expect(result.startsWith("..")).toBe(false);
        expect(result.includes("/../")).toBe(false);
      }),
      props(2004),
    );
  });

  /** Deterministic regression pin for the canonical escape attempt named in
   * docs/CONCORD_SHARED_STATE.md's test table: "Path escape refused —
   * `../../etc/passwd` as a document id is not written." */
  it("REGRESSION: '../../etc/passwd' does not escape to an absolute system path", () => {
    const result = normalisePath("../../etc/passwd");
    expect(result).toBe("etc/passwd");
    expect(result.startsWith("/")).toBe(false);
    expect(result.startsWith("..")).toBe(false);
  });
});

describe("covers() is reflexive", () => {
  /** covers.ts doc: "True when `resource` is covered by one of the
   * warrant's granted resources." Anything a warrant grants must cover
   * itself, or a warrant naming exactly the resource being requested would
   * fail to authorize it — the degenerate, most important case. */
  it("covers(g, g) is always true", () => {
    fc.assert(
      fc.property(fc.string(), (g) => {
        expect(covers(g, g)).toBe(true);
      }),
      props(2005),
    );
  });
});

describe("covers() respects path-segment boundaries", () => {
  /**
   * covers.ts doc: "A repo-file grant covers everything beneath it" —
   * *beneath*, i.e. at a "/"-delimited child, not merely sharing a string
   * prefix. A grant on "repo:foo" must not cover "repo:foobar": "foobar"
   * is a sibling file/dir whose name happens to start with "foo", not
   * something nested inside "foo".
   */
  it("a grant on a non-empty repo path covers its '/'-nested children", () => {
    fc.assert(
      fc.property(segmentsArb(1, 6), segmentsArb(0, 4), (baseSegs, childSegs) => {
        const granted = REPO_PREFIX + baseSegs.join("/");
        const resource = REPO_PREFIX + [...baseSegs, ...childSegs].join("/");
        expect(covers(granted, resource)).toBe(true);
      }),
      props(2006),
    );
  });

  it("a grant on a non-empty repo path does NOT cover a sibling whose name merely shares the prefix", () => {
    fc.assert(
      fc.property(segmentsArb(1, 6), segmentArb, (baseSegs, glueSuffix) => {
        const granted = REPO_PREFIX + baseSegs.join("/");
        // Glue directly onto the last segment (no "/" in between) so the
        // resource shares granted as a *string* prefix but is not nested
        // under it as a *path* — e.g. baseSegs=["foo"], glueSuffix="bar"
        // builds "repo:foo" vs "repo:foobar".
        const lastIndex = baseSegs.length - 1;
        const gluedSegs = baseSegs.map((s, i) => (i === lastIndex ? s + glueSuffix : s));
        const resource = REPO_PREFIX + gluedSegs.join("/");
        expect(covers(granted, resource)).toBe(false);
      }),
      props(2007),
    );
  });

  /** Deterministic regression pin for the exact example given in the task
   * brief: "repo:foo" must not cover "repo:foobar". */
  it("REGRESSION: repo:foo does not cover repo:foobar", () => {
    expect(covers("repo:foo", "repo:foobar")).toBe(false);
  });

  /** The one documented exception to the boundary rule: an empty suffix
   * ("repo:" itself) is a wildcard grant over everything beneath the repo
   * prefix, boundary or not — covers.ts's "everything beneath it" claim
   * taken to its widest case. */
  it("REGRESSION: the empty repo grant 'repo:' covers anything under the repo prefix", () => {
    expect(covers("repo:", "repo:foobar")).toBe(true);
    expect(covers("repo:", "repo:a/b/c")).toBe(true);
  });
});

describe("covers() is transitive", () => {
  /**
   * If warrant A's grant covers B's grant, and B's grant covers resource C,
   * then A's grant must cover C too — otherwise "covers everything
   * beneath it" would stop being true two levels down, which would make
   * nested delegation (a grant covering a narrower grant covering a file)
   * silently lose authority partway through the chain.
   *
   * Built as a genuine three-level nesting (a ⊆ b ⊆ c as repo paths) so the
   * premise covers(a,b) && covers(b,c) is guaranteed true by construction,
   * rather than relying on random strings to coincidentally satisfy it.
   */
  it("covers(a, b) && covers(b, c) implies covers(a, c), for nested repo grants", () => {
    fc.assert(
      fc.property(segmentsArb(0, 4), segmentsArb(0, 4), segmentsArb(0, 4), (aSegs, bExtra, cExtra) => {
        const bSegs = [...aSegs, ...bExtra];
        const cSegs = [...bSegs, ...cExtra];
        const a = REPO_PREFIX + aSegs.join("/");
        const b = REPO_PREFIX + bSegs.join("/");
        const c = REPO_PREFIX + cSegs.join("/");

        expect(covers(a, b)).toBe(true);
        expect(covers(b, c)).toBe(true);
        expect(covers(a, c)).toBe(true);
      }),
      props(2008),
    );
  });

  /**
   * General form of the same property (premise checked rather than
   * constructed) — a broader sanity net around the constructed case above,
   * including grants that aren't repo:-prefixed at all (where covers only
   * ever holds via exact string equality, and transitivity of equality is
   * trivially safe).
   *
   * TEST BUG (found and fixed here): the first version drew a, b, c from
   * plain fc.string(). Three independent random strings satisfying
   * covers(a,b) && covers(b,c) is astronomically unlikely (fast-check
   * confirmed it: 20001 skips against 18 successful runs, well past its
   * discard-ratio limit), so the property could never accumulate enough
   * cases to mean anything — a generator problem, not a covers() problem.
   * Fixed by drawing from a small, curated pool of resource-shaped strings
   * (exact duplicates, nested repo: paths, ws: exacts, and unrelated
   * strings) so covers-related pairs — and non-covers pairs, which
   * vacuously satisfy the implication — both occur often enough to sample.
   */
  it("covers(a, b) && covers(b, c) implies covers(a, c), for a mixed pool of resource-shaped strings", () => {
    const pool = [
      "repo:", // wildcard grant
      "repo:src", "repo:src/", "repo:src/a", "repo:src/a/b", "repo:src/a/b/c",
      "repo:src2", "repo:srcbar", // shares a string prefix with repo:src, not a path child
      "ws:sub-1", "ws:sub-1/", "ws:sub-2",
      "", "branch:integration",
    ];
    const poolArb = fc.constantFrom(...pool);
    fc.assert(
      fc.property(poolArb, poolArb, poolArb, (a, b, c) => {
        fc.pre(covers(a, b) && covers(b, c));
        expect(covers(a, c)).toBe(true);
      }),
      props(2009),
    );
  });
});
