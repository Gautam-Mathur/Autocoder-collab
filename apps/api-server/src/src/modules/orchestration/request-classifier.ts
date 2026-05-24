/**
 * Orchestration — Request Classifier (Task #18 split).
 *
 * Single entry point for "what kind of generation does this request need?".
 * Wraps the existing `selectOwningGenerator` and complexity classifier so
 * call sites (routes/autocoder.ts, conversation-phase-handler.ts,
 * pipeline-orchestrator.ts) all share one classification path.
 *
 * Pure: no I/O, no model calls, no side effects.
 */

import {
  selectOwningGenerator,
  describeGeneratorChoice,
  type SelectGeneratorInput,
  type SelectGeneratorResult,
  type OwningGeneratorKind,
} from '../generator-router.js';
import {
  classifyComplexity,
  type ComplexityProfile,
} from '../complexity-classifier.js';

export interface ClassifiedRequest {
  /** Router decision: which generator owns this request. */
  generator: SelectGeneratorResult;
  /** One-line label suitable for a thinking step. */
  generatorReason: string;
  /** Complexity profile (tier, run flags, file budget) when a description
   *  was supplied. */
  complexity?: ComplexityProfile;
}

export interface ClassifyOptions extends SelectGeneratorInput {
  /** Free-form prompt / project description used by the complexity
   *  classifier. When omitted, complexity is left undefined. */
  description?: string;
  archetypeId?: string | null;
}

export function classifyRequest(opts: ClassifyOptions): ClassifiedRequest {
  const generator = selectOwningGenerator({
    mode: opts.mode,
    isStandaloneScript: opts.isStandaloneScript,
    endpointHint: opts.endpointHint,
  });
  const generatorReason = describeGeneratorChoice(generator);

  let complexity: ComplexityProfile | undefined;
  if (opts.description) {
    try {
      complexity = classifyComplexity(opts.description, { archetypeId: opts.archetypeId });
    } catch {
      complexity = undefined;
    }
  }

  return { generator, generatorReason, complexity };
}

export { selectOwningGenerator, describeGeneratorChoice };
export type { SelectGeneratorInput, SelectGeneratorResult, OwningGeneratorKind };
