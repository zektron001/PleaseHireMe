/**
 * Which model each subtask gets.
 *
 * Deliberately a pure function of the subtask shape rather than a model call:
 * routing is a cost and latency decision, and a decision that costs a model call
 * to make is a bad routing policy. It is also then unit-testable.
 *
 * NOT part of the judged Track B surface - this is orchestration scaffolding.
 * It exists so the fan-out the authorization plane secures is realistic.
 */

export type Tier = "fast" | "balanced" | "deep";

export interface ModelTiers {
  /** Ark endpoint ids. All three may be the same id in the POC. */
  readonly fast: string;
  readonly balanced: string;
  readonly deep: string;
}

export interface SubtaskShape {
  readonly title: string;
  readonly description: string;
  readonly pathCount: number;
  /** Subtasks this one waits on. A blocker justifies a stronger model. */
  readonly dependencyCount: number;
}

const DEEP_SIGNALS = [
  "design",
  "architect",
  "refactor",
  "migrate",
  "security",
  "concurren",
  "performance",
  "schema",
];

const FAST_SIGNALS = [
  "rename",
  "typo",
  "comment",
  "changelog",
  "readme",
  "lint",
  "format",
  "docstring",
];

export function selectTier(shape: SubtaskShape): Tier {
  const text = (shape.title + " " + shape.description).toLowerCase();

  if (FAST_SIGNALS.some((s) => text.includes(s)) && shape.pathCount <= 2) {
    return "fast";
  }
  if (
    DEEP_SIGNALS.some((s) => text.includes(s)) ||
    shape.dependencyCount > 0 ||
    shape.pathCount >= 4
  ) {
    return "deep";
  }
  return "balanced";
}

export function selectModel(shape: SubtaskShape, tiers: ModelTiers): string {
  return tiers[selectTier(shape)];
}

/** Every tier maps to the configured endpoint unless overridden per tier. */
export function tiersFrom(
  arkModel: string,
  overrides: Partial<ModelTiers> = {},
): ModelTiers {
  return {
    fast: overrides.fast ?? arkModel,
    balanced: overrides.balanced ?? arkModel,
    deep: overrides.deep ?? arkModel,
  };
}
