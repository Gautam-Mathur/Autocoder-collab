/**
 * Generator Router (Task #17).
 *
 * Single source of truth for "which module owns initial file generation
 * for this run". The pipeline used to fan out across `plan-driven-generator`,
 * `ai-fullstack-generator`, `script-generator`, `pro-generator`, and
 * `advanced-code-generation` from different entry points; that fan-out is
 * what produced duplicate files, drifting imports, and conflicting
 * `package.json` patches.
 *
 * The router reads the already-derived `generationMode` (set by Task #16)
 * plus a few light signals (e.g. "this is a standalone Python script") and
 * returns ONE owning generator kind. Callers then dispatch to the matching
 * implementation. Other generator modules stay in the codebase but are no
 * longer invoked in parallel for the same request.
 */

import type { GenerationMode } from './generation-mode.js';

export type OwningGeneratorKind =
  | 'pipeline'        // in-pipeline Stage 11 (plan-driven-generator)
  | 'fullstack-llm'   // ai-fullstack-generator (LLM-streamed full project)
  | 'script'          // script-generator (single-language standalone scripts)
  | 'pro';            // pro-generator (REST endpoint /api/ai/deep/generate)

export interface SelectGeneratorInput {
  /** Generation mode derived by Task #16's classifier (Micro/Standard/Fullstack/Enterprise). */
  mode?: GenerationMode;
  /** True when `script-generator.detectStandaloneScript` returned a script intent. */
  isStandaloneScript?: boolean;
  /**
   * Set when the caller is one of the legacy REST endpoints whose contract is
   * to always run a specific generator (e.g. `/api/ai/deep/generate`). The
   * router still records the choice but does not second-guess it.
   */
  endpointHint?: OwningGeneratorKind;
}

export interface SelectGeneratorResult {
  kind: OwningGeneratorKind;
  reason: string;
}

/**
 * Decide which generator owns this run. Pure function — safe to call from
 * the orchestrator, the conversation phase handler, and the standalone REST
 * endpoints.
 *
 * Decision order:
 *   1. Explicit endpoint hint (legacy REST contract).
 *   2. Standalone script detection.
 *   3. Mode-based routing: Fullstack/Enterprise → fullstack-llm IF available.
 *      Micro/Standard → in-pipeline.
 *   4. Default: in-pipeline (safest fallback).
 *
 * Note: today the in-pipeline generator (`plan-driven-generator`) is robust
 * enough to handle Fullstack too, so the orchestrator currently always
 * runs `pipeline` for ctx-backed calls. This router records the decision so
 * future wiring can swap implementations without re-touching every call site.
 */
export function selectOwningGenerator(input: SelectGeneratorInput): SelectGeneratorResult {
  if (input.endpointHint) {
    return { kind: input.endpointHint, reason: `Endpoint contract pinned to ${input.endpointHint}` };
  }
  if (input.isStandaloneScript) {
    return { kind: 'script', reason: 'Detected a standalone-script request (single language, no framework)' };
  }
  switch (input.mode) {
    case 'Fullstack':
      return { kind: 'fullstack-llm', reason: 'Fullstack mode → ai-fullstack-generator (LLM-streamed full project)' };
    case 'Enterprise':
      // Enterprise needs the full RuFlo pipeline (architecture, schema,
      // hardening) — ai-fullstack-generator is too constrained.
      return { kind: 'pipeline', reason: 'Enterprise mode → in-pipeline generator (full RuFlo pipeline)' };
    case 'Micro':
    case 'Standard':
      return { kind: 'pipeline', reason: `${input.mode} mode → in-pipeline generator (Stage 11)` };
    default:
      return { kind: 'pipeline', reason: 'No mode signal yet — defaulting to in-pipeline generator' };
  }
}

/** Compact one-line description for thinking-step emission. */
export function describeGeneratorChoice(result: SelectGeneratorResult): string {
  return `Owning generator: ${result.kind} — ${result.reason}`;
}
