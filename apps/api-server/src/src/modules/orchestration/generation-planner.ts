/**
 * Orchestration — Generation Planner (Task #18 split).
 *
 * Owns "what should the pipeline produce?":
 *   - turning understanding into a plan (delegating to plan-generator)
 *   - applying the complexity profile to pin a generation mode + budget
 *
 * The orchestrator already inlines this logic; this module exposes the same
 * primitives behind one import surface so future refactors can lift the
 * inline code without changing call sites.
 */

import { generatePlan, type ProjectPlan } from '../plan-generator.js';
import type { UnderstandingResult } from '../deep-understanding-engine.js';
import {
  classifyComplexity,
  type ComplexityProfile,
} from '../complexity-classifier.js';
import {
  deriveGenerationMode,
  getBudget,
  type GenerationMode,
  type GenerationBudget,
} from '../generation-mode.js';

export interface PlannedGeneration {
  plan: ProjectPlan;
  complexity: ComplexityProfile;
  mode: GenerationMode;
  budget: GenerationBudget;
}

export interface PlanGenerationOptions {
  archetypeId?: string | null;
  /** When supplied, this plan is used as-is (skipping plan generation). */
  prebuiltPlan?: ProjectPlan;
  /** Free-form description used by the complexity classifier. Falls back to
   *  understanding.userMessage if available. */
  description?: string;
}

export function planGeneration(
  understanding: UnderstandingResult,
  opts: PlanGenerationOptions = {},
): PlannedGeneration {
  const plan = opts.prebuiltPlan ?? generatePlan(understanding);
  const description =
    opts.description ??
    (understanding as any)?.userMessage ??
    (plan as { overview?: string }).overview ??
    plan.projectName ??
    '';
  const complexity = classifyComplexity(description, { archetypeId: opts.archetypeId });
  const mode = deriveGenerationMode(complexity, { archetypeId: opts.archetypeId });
  const budget = getBudget(mode);
  return { plan, complexity, mode, budget };
}

export { classifyComplexity, deriveGenerationMode, getBudget };
export type { ProjectPlan, ComplexityProfile, GenerationMode, GenerationBudget };
