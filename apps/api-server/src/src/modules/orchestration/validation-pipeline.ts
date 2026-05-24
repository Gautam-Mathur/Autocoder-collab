/**
 * Orchestration — Validation Pipeline (Task #18 split).
 *
 * Bundles the post-generation validation primitives so callers don't have to
 * know about three separate modules:
 *   - import-validator         — strips hallucinated package imports
 *   - cross-file-validator     — checks import/export, api contracts, schemas
 *   - project-graph (Stage 14.5) — builds the dependency graph and reports
 *                                  unresolved imports / missing exports /
 *                                  missing routes / undeclared deps
 *
 * Returning a single `ValidationOutcome` lets the orchestrator (and tests)
 * call one entry and inspect every layer's result.
 */

import {
  validateImports,
  applyValidation,
  type ImportValidationResult,
  type ValidatorFile,
} from '../import-validator.js';
import {
  validateCrossFileConsistency,
  type ConsistencyReport,
} from '../cross-file-validator.js';
import {
  buildProjectGraph,
  verifyProjectGraph,
  formatVerificationErrors,
  type ProjectGraph,
  type GraphVerificationResult,
} from '../project-graph/index.js';

export interface ValidationOutcome {
  imports: ImportValidationResult;
  crossFile: ConsistencyReport;
  graph: ProjectGraph;
  graphVerification: GraphVerificationResult;
  /** True only when every layer passed cleanly. */
  passed: boolean;
}

export interface ValidationFile extends ValidatorFile {
  language?: string;
}

export function runFullValidation(files: ValidationFile[]): ValidationOutcome {
  const imports = validateImports(files);
  const patched = applyValidation(files, imports);
  const crossFile = validateCrossFileConsistency(
    patched.map(f => ({ path: f.path, content: f.content, language: f.language || '' })),
  );
  const graph = buildProjectGraph(patched.map(f => ({ path: f.path, content: f.content, language: f.language })));
  const graphVerification = verifyProjectGraph(graph, patched.map(f => ({ path: f.path, content: f.content, language: f.language })));
  const passed =
    imports.removed.size === 0 &&
    crossFile.issues.filter(i => i.severity === 'error').length === 0 &&
    graphVerification.passed;
  return { imports, crossFile, graph, graphVerification, passed };
}

export interface GraphStageInput {
  files: { path: string; content: string; language?: string }[];
  testFiles?: { path: string; content: string; language?: string }[];
}

export interface GraphStageOutput {
  graph: ProjectGraph;
  verification: GraphVerificationResult;
  /** Pre-formatted "[graph] ..." error lines, ready for the auto-fix loop. */
  errorLines: string[];
  /** Per-step thinking-step metadata so the orchestrator can emit ONE step. */
  step: { phase: string; label: string; detail: string };
}

/**
 * Run Stage 14.5 (Task #18) — pure function so the orchestrator can delegate
 * the entire build-graph + verify cycle to one call. Never throws — on any
 * internal failure returns an empty-but-shaped result so the pipeline can
 * carry on.
 */
export function runGraphVerificationStage(input: GraphStageInput): GraphStageOutput {
  const merged = [...input.files, ...(input.testFiles || [])].map(f => ({
    path: f.path,
    content: f.content,
    language: f.language,
  }));
  try {
    const graph = buildProjectGraph(merged);
    const verification = verifyProjectGraph(graph, merged);
    const errorLines = verification.passed ? [] : formatVerificationErrors(verification);
    const phaseLabel = verification.passed ? 'Project graph verified' : 'Project graph issues found';
    const detail = verification.passed
      ? `${verification.stats.files} files | ${verification.stats.routesRegistered} routes | ${verification.stats.apiCalls} api calls — all resolved`
      : `Unresolved imports: ${verification.unresolvedImports.length} | Missing exports: ${verification.missingExports.length} | Missing routes: ${verification.missingRoutes.length} | Undeclared deps: ${verification.undeclaredDependencies.length}`;
    return {
      graph,
      verification,
      errorLines,
      step: { phase: 'graph-verify', label: `${phaseLabel}|||Graph verification`, detail },
    };
  } catch (err) {
    const empty: ProjectGraph = { nodes: [], edges: [], filesIndexed: 0, byKind: { file: [], component: [], hook: [], route: [], 'api-client': [] } };
    const verification: GraphVerificationResult = {
      unresolvedImports: [], missingRoutes: [], missingExports: [], undeclaredDependencies: [],
      passed: true, summary: 'Graph verification skipped', totalIssues: 0,
      stats: { nodes: 0, edges: 0, files: 0, routesRegistered: 0, apiCalls: 0 },
    };
    return {
      graph: empty,
      verification,
      errorLines: [],
      step: { phase: 'graph-verify', label: 'Graph verification skipped|||Graph verifier error', detail: String(err).slice(0, 160) },
    };
  }
}

export {
  validateImports, applyValidation,
  validateCrossFileConsistency,
  buildProjectGraph, verifyProjectGraph, formatVerificationErrors,
  type ImportValidationResult, type ConsistencyReport,
  type ProjectGraph, type GraphVerificationResult,
};
