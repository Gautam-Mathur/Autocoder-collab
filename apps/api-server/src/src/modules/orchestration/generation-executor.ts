/**
 * Orchestration — Generation Executor (Task #18 split).
 *
 * Thin facade over the existing pipeline orchestrator. The big
 * `runPipeline` / `orchestrateGeneration` function in
 * `pipeline-orchestrator.ts` is the single execution path; this module just
 * exposes it under the orchestration/* namespace so future call sites can
 * import from one place.
 *
 * Re-exports keep types portable and let callers depend on
 * `modules/orchestration/*` instead of the concrete file path.
 */

import {
  orchestrateGeneration,
  orchestratePlanning,
  type OrchestrationResult,
  type PipelineContext,
  type PipelineMetrics,
  type PipelineSummary,
  type ThinkingStep,
} from '../pipeline-orchestrator.js';

export {
  orchestrateGeneration,
  orchestratePlanning,
  type OrchestrationResult,
  type PipelineContext,
  type PipelineMetrics,
  type PipelineSummary,
  type ThinkingStep,
};

/**
 * Convenience wrapper: returns just the file payload most external callers
 * need, suppressing the broader OrchestrationResult shape.
 */
export async function executeGeneration(
  ...args: Parameters<typeof orchestrateGeneration>
): Promise<OrchestrationResult> {
  return orchestrateGeneration(...args);
}
