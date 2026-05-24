/**
 * Pipeline Orchestrator
 *
 * Runs the legacy planning/enrichment stages (understand → plan → learn →
 * reason → architect → design → specify → schema → api → compose) and then
 * delegates code generation, debug, security, review, and tests to the
 * 10-agent RuFlo pipeline (see ruflo/sequential-controller.ts).
 */

import type { ProjectPlan, PlannedEntity } from './plan-generator.js';
import type { UnderstandingResult } from './deep-understanding-engine.js';
import type { ReasoningResult, ComputedField } from './contextual-reasoning-engine.js';
import type { DesignSystem } from './design-system-engine.js';
import type { FunctionalitySpec } from './functionality-engine.js';
import type { ArchitecturePlan } from './architecture-planner.js';
import type { SchemaDesign } from './schema-designer.js';
import type { APIDesign } from './api-designer.js';
import type { ComponentTree } from './component-composer.js';
import type { QualityReport } from './code-quality-engine.js';
import type { DependencyManifest } from './dependency-resolver.js';

import { analyzeRequest } from './deep-understanding-engine.js';
import { generatePlan } from './plan-generator.js';
import { analyzeSemantics } from './contextual-reasoning-engine.js';
import { generateDesignSystem } from './design-system-engine.js';
import { generateFunctionalitySpec } from './functionality-engine.js';
import { planArchitecture } from './architecture-planner.js';
import { designSchema } from './schema-designer.js';
import { designAPI } from './api-designer.js';
import { composeComponents } from './component-composer.js';
import { analyzeCodeQuality, buildQualityEnhancementPatch } from './code-quality-engine.js';
import { resolveDependencies } from './dependency-resolver.js';
import { validateImports, applyValidation, type ImportValidationResult } from './import-validator.js';
import { generateProjectFromPlan } from './plan-driven-generator.js';
import { appArchetypes, detectArchetypeVarieties, impliedConceptsFromVarieties } from '../templates/app-archetypes.js';
import { detectConcepts, applyConceptOverlays, filterConceptsToRequested } from '../templates/concept-library.js';
import { getScaffold } from '../templates/scaffolds/runnable-scaffolds.js';
import { templateRegistry } from './template-registry.js';
import { classifyComplexity, complexitySignature, type ComplexityProfile } from './complexity-classifier.js';
import {
  deriveGenerationMode,
  getBudget,
  enforceFileBudget,
  type GenerationMode,
  type GenerationBudget,
} from './generation-mode.js';
import { extractRequestedFeatures } from './feature-extractor.js';
import { recordComplexityOutcome } from './complexity-learning-store.js';
import { buildSnapshotAsync, upgradePackageJson } from './snapshot-builder.js';
import { createHash } from 'crypto';
import { validateAndFix } from './post-generation-validator.js';
import {
  openRepairBranch,
  commitBranch,
  discardBranch,
  validateBranch,
  commitOrDiscard,
  makeNoRegressionValidator,
  summarizeRepairAudit,
  assertNoDirectWrite,
  type RepairAuditEntry,
  type BranchValidation,
} from './repair-branch.js';
import { parseErrors, analyzeAndFix as viteAnalyzeAndFix } from './vite-error-fixer.js';
import { isSLMAvailable, runSLM } from './slm-inference-engine.js';
import { UNDERSTANDING_STAGE_ID, mergeUnderstandingResults } from './slm-stage-understanding.js';
import { CODEGEN_STAGE_ID, buildCodegenEnhancementPatch, validateCodeEnhancement } from './slm-stage-codegen.js';
import type { CodeEnhancement } from './slm-stage-codegen.js';
import { SEMANTIC_STAGE_ID, mergeSemanticResults } from './slm-stage-semantic.js';
import { DESIGN_STAGE_ID, mergeDesignResults } from './slm-stage-design.js';
import { SCHEMA_STAGE_ID, validateSchemaPatch } from './slm-stage-schema.js';
import { API_STAGE_ID, validateAPIPatch } from './slm-stage-api.js';
import { COMPONENT_STAGE_ID, validateComponentPatch } from './slm-stage-components.js';
import { QUALITY_STAGE_ID, processQualityResults } from './slm-stage-quality.js';
import {
  runSLMWithHealth,
  summarizeSLMHealth,
  publishHealthRecords,
  validators as healthValidators,
  type SLMHealthRecord,
} from './slm-health-monitor.js';
import { generateTestFiles } from './test-generator.js';
import { learningEngine } from './generation-learning-engine.js';
import { inferEntityFields, isSemanticDuplicate } from './entity-field-inference.js';
import { planUXFlows } from './ux-flow-planner.js';
import { planIntegrations } from './integration-planner.js';
import { planSecurity } from './security-planner.js';
import { planPerformance } from './performance-planner.js';
import { validateCrossFileConsistency, buildConsistencyEnhancementPatch } from './cross-file-validator.js';
import { hardenGeneratedCode, buildHardeningEnhancementPatch } from './code-hardening-pass.js';
import { verifyTypeContracts } from './type-contract-verifier.js';
import { scanAntiPatterns } from './anti-pattern-scanner.js';
import { scoreProjectQuality, formatQualityReport } from './quality-scoring-engine.js';
import type { QualityPassResults } from './quality-scoring-engine.js';
import { retrieveForStage } from './knowledge-retrieval/stage-retriever.js';
import { buildKnowledgeIndex } from './knowledge-retrieval/chunk-index.js';
import { buildTaskGraph } from './task-graph/task-graph-builder.js';
import { routeToStack, detectStackFromPlan } from './stacks/stack-router.js';
import type { CodeAction, ActionContext } from './code-actions.js';
import { recordAction as recordCodeAction, getActionSummary, buildActionProgressMessage } from './code-actions.js';
import {
  applyEnhancementPatches,
  patchFromFullFileReplacement,
  type EnhancementPatch,
} from './enhancement-patch.js';
import { selectOwningGenerator, describeGeneratorChoice } from './generator-router.js';
import {
  buildProjectGraph,
  verifyProjectGraph,
  type ProjectGraph,
  type GraphVerificationResult,
} from './project-graph/index.js';
import * as orchestrationValidationPipeline from './orchestration/validation-pipeline.js';
import * as orchestrationRepairPipeline from './orchestration/repair-pipeline.js';
import {
  validateSemantics,
  formatSemanticErrors,
  type SemanticValidationResult,
} from './semantic-validator.js';

function deepClonePlan(plan: ProjectPlan): ProjectPlan {
  return JSON.parse(JSON.stringify(plan));
}

interface EntityIntelligenceContext {
  inferredRelationships: Array<{ from: string; to: string; type: string }>;
  upgradedEntities: string[];
}

export interface GeneratedFile {
  path: string;
  content: string;
  language: string;
}

export interface ThinkingStep {
  phase: string;
  label: string;
  detail?: string;
  timestamp: number;
  reasoning?: string;
  filesAffected?: string[];
}

export interface PipelineStage {
  id: string;
  name: string;
  role: string;
  description: string;
  order: number;
  critical: boolean;
}

export interface StageResult {
  stageId: string;
  success: boolean;
  durationMs: number;
  qualityScore: number;
  warnings: string[];
  errors: string[];
  output: unknown;
}

export interface QualityGate {
  stageId: string;
  passed: boolean;
  score: number;
  threshold: number;
  issues: string[];
}

export interface PipelineMetrics {
  totalDurationMs: number;
  stageResults: Map<string, StageResult>;
  qualityGates: QualityGate[];
  overallScore: number;
  fileCount: number;
  lineCount: number;
  componentCount: number;
  endpointCount: number;
}

// Fix 5 — Single-Writer Enforcement: a file-level diff queued by post-Stage-11
// stages and drained by the validate stage. Last-writer-per-file wins.
export interface FileDiff {
  file: string;     // path within the project
  content: string;  // full new file contents
  source: string;   // emitting stage id (audit trail)
}

export interface PipelineContext {
  userRequest: string;
  conversationHistory?: string;
  understanding?: UnderstandingResult;
  plan?: ProjectPlan;
  frozenPlan?: ProjectPlan;
  entityIntelligenceCtx?: EntityIntelligenceContext;
  reasoning?: ReasoningResult;
  detectedDomain?: string;
  architecture?: ArchitecturePlan;
  designSystem?: DesignSystem;
  functionalitySpec?: FunctionalitySpec;
  schemaDesign?: SchemaDesign;
  apiDesign?: APIDesign;
  componentTree?: ComponentTree;
  files: GeneratedFile[];
  importValidation?: ImportValidationResult;
  dependencyManifest?: DependencyManifest;
  qualityReport?: QualityReport;
  validationSummary?: { passes: number; issuesFound: number; issuesFixed: number; unfixableIssues: string[]; warnings?: number };
  slmStagesRun: string[];
  slmHealth?: SLMHealthRecord[];
  testFiles: GeneratedFile[];
  metrics: PipelineMetrics;
  thinkingSteps: ThinkingStep[];
  onStep?: (step: ThinkingStep) => void;
  actions: CodeAction[];
  // Fix 5 — Single-Writer Enforcement
  writeLock?: boolean;            // when true, post-Stage-11 stages enqueue instead of mutating
  pendingDiffs?: FileDiff[];      // drained by Stage 15 (validate) at its very start
  // Task #23 — Sandboxed Repair Branches.
  // `branchOpen` is set true while a `RepairBranch` is open on this ctx;
  // direct writes to ctx.files during that window trigger the no-direct-
  // write assertion (see modules/repair-branch.ts).
  // `repairAudit` accumulates one entry per branch (committed | discarded)
  // and is surfaced via OrchestrationResult.repairAudit.
  branchOpen?: boolean;
  repairAudit?: RepairAuditEntry[];
  // Task #18 — Project dependency graph + Stage 14.5 verification result.
  // Both are best-effort outputs surfaced to the chat UI and the auto-fix loop;
  // a missing graph never blocks the pipeline.
  projectGraph?: ProjectGraph;
  graphVerification?: GraphVerificationResult;
  // Task #22 — semantic coherence result (orphan state, dead routes,
  // duplicate ownership, circular UI, impossible data flows). Best-effort.
  semanticValidation?: SemanticValidationResult;
  // Layer C — Context-aware sizing (set by `applyComplexityProfile`).
  // When present, downstream stages use it to scale concept defaults,
  // skip optional stages, and stick strictly to user-requested features.
  complexityProfile?: ComplexityProfile;
  requestedFeatures?: string[];
  requestedConcepts?: string[];
  // Task #16 — Generation Mode + per-mode hard budget, derived from the
  // complexity profile right after classification. Producers (compose,
  // generate, advanced-code-generation, deep-project-generator, pro-generator,
  // codegen-orchestrator) must respect `generationBudget`.
  generationMode?: GenerationMode;
  generationBudget?: GenerationBudget;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix 5 — Single-Writer Enforcement helpers
//
// Post-Stage-11 stages (quality, deep-quality, …) used to mutate `ctx.files`
// directly. When two stages patched the same file, the later one silently
// clobbered the earlier one and produced output that satisfied neither
// stage's intent. The fix routes all post-Stage-11 mutations through a queue
// that the validate stage drains as its first operation. Last-writer-per-file
// wins, with a `source` label for audit.
//
// `enqueueFileSnapshot` is the high-level API used by stages that compute a
// fresh full file array (e.g. `applyQualityFixes` → new array). It diffs the
// proposed array against the current `ctx.files` and pushes one `FileDiff`
// per changed/added file.
//
// `applyPendingDiffs` collapses the queue (last-writer-per-file wins) and
// applies it to `ctx.files`. It returns the count of files actually changed.
// Safe to call when the queue is empty — it is a no-op.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Layer A/B — Re-derive the reference scaffold for the current request from
 * `ctx.userRequest` + `ctx.plan?.projectName`. Done at codegen time (rather
 * than threaded via PipelineContext) to keep the orchestrator surface small.
 *
 * Returns `undefined` when no archetype matches strongly enough; the codegen
 * orchestrator then falls through to its generic page-builder pipeline.
 */
function deriveReferenceScaffold(ctx: PipelineContext): {
  archetypeId: string;
  scaffoldId: string;
  matchScore: number;
  files: GeneratedFile[];
  appliedConcepts: string[];
  varieties: string[];
} | undefined {
  try {
    const description = [ctx.userRequest, ctx.plan?.projectName, ctx.plan?.projectDescription]
      .filter(Boolean)
      .join(' ');
    if (!description.trim()) return undefined;

    // Use the same template-registry BM25 ranker that interpretIntent uses.
    const matches = templateRegistry.findArchetypes(description, 3);
    if (matches.length === 0) return undefined;

    const top = matches[0];
    if (top.matchScore < 0.55) return undefined;

    const archetype =
      appArchetypes.find((a) => a.id === top.id) ||
      appArchetypes.find((a) => a.name.toLowerCase() === top.name.toLowerCase());
    if (!archetype || !archetype.scaffoldId) return undefined;

    const varietyIds = detectArchetypeVarieties(archetype, description);
    const fromVarieties = impliedConceptsFromVarieties(archetype, varietyIds);
    const fromDescription = detectConcepts(description, archetype.id);
    let conceptIds = Array.from(new Set([
      ...(archetype.conceptTags || []),
      ...fromVarieties,
      ...fromDescription,
    ]));

    // Layer C — "stick to features": in strict mode (small/minimal tiers)
    // drop default `conceptTags` and any concept the user did not ask for.
    // Always keep concepts implied by detected varieties, since those are
    // the file-overlay concepts that make the scaffold match the variety.
    if (ctx.complexityProfile?.strictFeatureMode && ctx.requestedConcepts) {
      const before = conceptIds.length;
      conceptIds = filterConceptsToRequested(
        conceptIds,
        [...ctx.requestedConcepts, ...fromDescription],
        fromVarieties,
      );
      if (conceptIds.length !== before) {
        console.log(`[Pipeline] strict-feature mode dropped ${before - conceptIds.length} default concept(s)`);
      }
    } else if (ctx.complexityProfile && conceptIds.length > ctx.complexityProfile.conceptBudget + fromVarieties.length) {
      // Soft cap for non-strict tiers: prefer description-detected over defaults.
      const must = new Set([...fromVarieties, ...fromDescription]);
      const defaults = conceptIds.filter((c) => !must.has(c));
      const allowedDefaults = defaults.slice(0, Math.max(0, ctx.complexityProfile.conceptBudget - must.size));
      conceptIds = Array.from(new Set([...must, ...allowedDefaults]));
    }

    const effectiveScaffoldId =
      archetype.id === 'todo' && varietyIds.includes('fullstack')
        ? 'fullstack-todo'
        : archetype.scaffoldId;

    const scaffoldFiles = getScaffold(effectiveScaffoldId);
    if (!scaffoldFiles) return undefined;

    const { files } = applyConceptOverlays(scaffoldFiles, conceptIds);
    return {
      archetypeId: archetype.id,
      scaffoldId: effectiveScaffoldId,
      matchScore: top.matchScore,
      files: files.map((f) => ({ path: f.path, content: f.content, language: f.language })),
      appliedConcepts: conceptIds,
      varieties: varietyIds,
    };
  } catch (err) {
    console.warn('[Pipeline] deriveReferenceScaffold failed (non-fatal):', err);
    return undefined;
  }
}

function enqueueFileSnapshot(ctx: PipelineContext, newFiles: GeneratedFile[], source: string): number {
  // Task #23 — direct-write choke point. If a repair branch is open
  // (e.g. Stage 15 mid-run), the caller MUST mutate the branch's files
  // and let the branch's commit handle merging. Throws in dev so the
  // missed migration is caught immediately; warns-once in prod.
  assertNoDirectWrite(ctx, `enqueueFileSnapshot:${source}`);
  if (!ctx.pendingDiffs) ctx.pendingDiffs = [];
  const currentByPath = new Map(ctx.files.map(f => [f.path, f.content]));
  let queued = 0;
  for (const f of newFiles) {
    const curContent = currentByPath.get(f.path);
    if (curContent === undefined || curContent !== f.content) {
      ctx.pendingDiffs.push({ file: f.path, content: f.content, source });
      queued++;
    }
  }
  return queued;
}

/**
 * Throttle the per-file generation progress callback so the chat does not
 * fill up with 25× "Working on it" rows. Emits ONE step per distinct phase
 * (e.g. "schema", "routes", "components"), summarised on phase change or
 * on flush() with the count of files emitted while in that phase.
 */
type ThrottledEmitter = ((phase: string, detail: string) => void) & { flush: () => void };
function makeThrottledPhaseEmitter(ctx: PipelineContext, stageId: string): ThrottledEmitter {
  let currentPhase: string | null = null;
  let currentCount = 0;
  let lastDetail = '';
  const flushCurrent = () => {
    if (currentPhase !== null && currentCount > 0) {
      const friendly = `Generated ${currentCount} ${currentPhase} file${currentCount === 1 ? '' : 's'}`;
      const technical = `[${stageId}/${currentPhase}] last=${lastDetail.slice(0, 80)}`;
      emitStep(ctx, stageId, `${friendly}|||${technical}`, undefined);
    }
  };
  const fn = ((phase: string, detail: string) => {
    if (phase !== currentPhase) {
      flushCurrent();
      currentPhase = phase;
      currentCount = 1;
      lastDetail = detail;
    } else {
      currentCount++;
      lastDetail = detail;
    }
  }) as ThrottledEmitter;
  fn.flush = () => { flushCurrent(); currentPhase = null; currentCount = 0; };
  return fn;
}

function applyPendingDiffs(ctx: PipelineContext): number {
  if (!ctx.pendingDiffs || ctx.pendingDiffs.length === 0) return 0;
  // Last-writer-per-file wins. Preserve insertion order for adds.
  const merged = new Map<string, FileDiff>();
  for (const d of ctx.pendingDiffs) merged.set(d.file, d);
  let applied = 0;
  for (const diff of merged.values()) {
    const idx = ctx.files.findIndex(f => f.path === diff.file);
    if (idx >= 0) {
      if (ctx.files[idx].content !== diff.content) {
        ctx.files[idx] = { ...ctx.files[idx], content: diff.content };
        applied++;
      }
    } else {
      ctx.files.push({ path: diff.file, content: diff.content, language: diff.file.split('.').pop() || '' });
      applied++;
    }
  }
  ctx.pendingDiffs = [];
  return applied;
}

export interface OrchestrationResult {
  success: boolean;
  files: GeneratedFile[];
  testFiles: GeneratedFile[];
  context: PipelineContext;
  metrics: PipelineMetrics;
  summary: PipelineSummary;
  snapshotHash?: string | null;
  slmHealth?: SLMHealthRecord[];
  /** Layer C — surfaced so chat UI can show "Mode: MINIMAL · 4/8 files". */
  complexityProfile?: ComplexityProfile;
  generationMode?: GenerationMode;
  generationBudget?: GenerationBudget;
  /** Task #18 — exposed so the chat UI can show graph health and the
   * auto-fix loop can re-run with `errorType: 'graph'`. */
  projectGraph?: ProjectGraph;
  graphVerification?: GraphVerificationResult;
  /** Task #22 — semantic coherence defects surfaced to chat UI. */
  semanticValidation?: SemanticValidationResult;
  /** Task #23 — per-attempt repair branch audit (committed | discarded). */
  repairAudit?: RepairAuditEntry[];
  actionSummary?: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    byType: Record<string, number>;
    byStage: Record<string, number>;
  };
  /** Initiative E — pipeline plugin run audit. */
  pluginAudit?: Array<{ pluginId: string; hook: string; status: 'ran' | 'error' | 'skipped'; durationMs: number; notes?: string; error?: string }>;
}

export interface PipelineSummary {
  totalStages: number;
  completedStages: number;
  failedStages: string[];
  skippedStages: string[];
  overallQuality: number;
  highlights: string[];
  warnings: string[];
}

// User-facing stage names describe the WORK each stage performs, not a
// fictional human role. Keep `id` strings stable — they are used as keys.
const PIPELINE_STAGES: PipelineStage[] = [
  { id: 'understand', name: 'Understand request', role: 'Requirement analysis', description: 'Analyzes user request, decomposes intent, detects domain', order: 1, critical: true },
  { id: 'plan', name: 'Plan project', role: 'Project planning', description: 'Creates detailed project plan with modules, pages, endpoints', order: 2, critical: true },
  { id: 'learn', name: 'Apply learned patterns', role: 'Pattern application', description: 'Applies learned patterns from previous successful generations', order: 3, critical: false },
  { id: 'reason', name: 'Reason about data', role: 'Semantic analysis', description: 'Analyzes entity relationships, field semantics, business rules', order: 4, critical: true },
  { id: 'architect', name: 'Plan architecture', role: 'Architecture planning', description: 'Determines folder structure, state management, auth, data flow patterns', order: 5, critical: true },
  { id: 'design', name: 'Build design system', role: 'Design system', description: 'Generates domain-aware color palettes, typography, animations, dark mode', order: 6, critical: true },
  { id: 'specify', name: 'Specify features', role: 'Functionality specification', description: 'Maps entity types to interactive features, page layouts, CRUD enhancements', order: 7, critical: true },
  { id: 'schema', name: 'Design database schema', role: 'Schema design', description: 'Designs normalized schemas, indexes, constraints, audit trails', order: 8, critical: true },
  { id: 'api', name: 'Design API surface', role: 'API design', description: 'Designs RESTful endpoints, validation, error handling, pagination', order: 9, critical: true },
  { id: 'compose', name: 'Compose UI tree', role: 'Component composition', description: 'Plans component tree, prop flow, reusable components, accessibility', order: 10, critical: true },
  { id: 'generate', name: 'Generate code', role: 'Code generation', description: 'Generates all project files from enriched plan and specs', order: 11, critical: true },
  { id: 'resolve', name: 'Resolve dependencies', role: 'Dependency resolution', description: 'Resolves packages, checks compatibility, optimizes bundle', order: 12, critical: false },
  { id: 'quality', name: 'Check code quality', role: 'Quality assurance', description: 'Enforces best practices, detects code smells, checks accessibility', order: 13, critical: false },
  { id: 'test', name: 'Generate tests', role: 'Test generation', description: 'Generates unit, integration, and component tests', order: 14, critical: false },
  { id: 'graph-verify', name: 'Verify project graph', role: 'Project graph verification', description: 'Builds the project dependency graph and reports unresolved imports, missing exports, missing routes, and undeclared dependencies', order: 14.5, critical: false },
  { id: 'validate', name: 'Validate & auto-fix', role: 'Validation & auto-fix', description: 'Validates imports, dependencies, fixes common issues', order: 15, critical: true },
  { id: 'deep-quality', name: 'Deep quality analysis', role: 'Deep quality analysis', description: 'Cross-file consistency, code hardening, type contracts, anti-patterns, quality scoring', order: 16, critical: false },
  { id: 'record', name: 'Record learnings', role: 'Learning & recording', description: 'Records patterns and outcomes for future improvements', order: 17, critical: false },
];

function createEmptyMetrics(): PipelineMetrics {
  return {
    totalDurationMs: 0,
    stageResults: new Map(),
    qualityGates: [],
    overallScore: 0,
    fileCount: 0,
    lineCount: 0,
    componentCount: 0,
    endpointCount: 0,
  };
}

type OnStepCallback = (step: ThinkingStep) => void;

function emitStep(ctx: PipelineContext, phase: string, label: string, detail?: string) {
  const step: ThinkingStep = { phase, label, detail, timestamp: Date.now() };
  ctx.thinkingSteps.push(step);
  if (ctx.onStep) ctx.onStep(step);
}

function toActionContext(ctx: PipelineContext): ActionContext {
  return {
    actions: ctx.actions,
    thinkingSteps: ctx.thinkingSteps,
    onStep: ctx.onStep,
  };
}

function recordFileActions(
  ctx: PipelineContext,
  stage: string,
  oldFiles: GeneratedFile[],
  newFiles: GeneratedFile[],
  reason: string
): void {
  const actx = toActionContext(ctx);
  const oldMap = new Map(oldFiles.map(f => [f.path, f]));
  const newMap = new Map(newFiles.map(f => [f.path, f]));

  for (const [path, file] of newMap) {
    const old = oldMap.get(path);
    if (!old) {
      recordCodeAction(actx, 'CreateFile', stage, {
        filePath: path,
        language: file.language,
        newContent: file.content,
        linesChanged: file.content.split('\n').length,
      }, `${reason}: created ${path}`, { emitThinkingStep: false });
    } else if (old.content !== file.content) {
      const oldLines = old.content.split('\n');
      const newLines = file.content.split('\n');
      let changed = 0;
      const max = Math.max(oldLines.length, newLines.length);
      for (let i = 0; i < max; i++) {
        if ((oldLines[i] || '') !== (newLines[i] || '')) changed++;
      }
      recordCodeAction(actx, 'ModifyFile', stage, {
        filePath: path,
        language: file.language,
        linesChanged: Math.max(changed, 1),
      }, `${reason}: modified ${path}`, { emitThinkingStep: false });
    }
  }

  for (const [path] of oldMap) {
    if (!newMap.has(path)) {
      recordCodeAction(actx, 'DeleteFile', stage, {
        filePath: path,
      }, `${reason}: deleted ${path}`, { emitThinkingStep: false });
    }
  }
}

function runQualityGate(stageId: string, score: number, threshold: number, issues: string[]): QualityGate {
  return {
    stageId,
    passed: score >= threshold,
    score,
    threshold,
    issues: issues.filter(Boolean),
  };
}

function executeStage(
  ctx: PipelineContext,
  stage: PipelineStage,
  executor: () => { score: number; warnings: string[]; output: unknown },
  maxRetries: number = 0
): StageResult {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const start = Date.now();
    try {
      const result = executor();
      const duration = Date.now() - start;
      const stageResult: StageResult = {
        stageId: stage.id,
        success: true,
        durationMs: duration,
        qualityScore: result.score,
        warnings: result.warnings,
        errors: [],
        output: result.output,
      };

      const gate = runQualityGate(stage.id, result.score, stage.critical ? 60 : 40, result.warnings);
      ctx.metrics.qualityGates.push(gate);
      ctx.metrics.stageResults.set(stage.id, stageResult);

      if (!gate.passed && stage.critical) {
        if (attempt < maxRetries) {
          emitStep(ctx, stage.id, `Retrying a step|||${stage.name} quality gate failed, retrying`,
            `Critical stage scored ${gate.score}/${gate.threshold} — retry ${attempt + 1}/${maxRetries}`);
          continue;
        }
        const gateWarning = `Quality gate failed for critical stage "${stage.name}" (${gate.score}/${gate.threshold}): ${gate.issues.length > 0 ? gate.issues.join('; ') : 'score below threshold'}`;
        console.warn(`[Pipeline] ${gateWarning}`);
        stageResult.warnings.push(gateWarning);
        emitStep(ctx, stage.id, `Step needs attention|||${stage.name} quality gate failed`,
          `Critical stage scored ${gate.score}/${gate.threshold} — exhausted ${maxRetries} retries, proceeding with best result`);
      } else if (!gate.passed) {
        const gateWarning = `Quality gate failed for stage "${stage.name}" (${gate.score}/${gate.threshold})`;
        console.warn(`[Pipeline] ${gateWarning}`);
        stageResult.warnings.push(gateWarning);
      }

      emitStep(ctx, stage.id, `Step complete|||${stage.name} complete`,
        `${stage.role}: score ${result.score}/100 in ${duration}ms${result.warnings.length > 0 ? ` (${result.warnings.length} warnings)` : ''}`);

      return stageResult;
    } catch (err) {
      lastErr = err;
      const duration = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (attempt < maxRetries) {
        emitStep(ctx, stage.id, `Retrying|||${stage.name} failed, retrying`,
          `Attempt ${attempt + 1}/${maxRetries + 1}: ${errorMsg}`);
        continue;
      }

      const stageResult: StageResult = {
        stageId: stage.id,
        success: false,
        durationMs: duration,
        qualityScore: 0,
        warnings: [],
        errors: [errorMsg],
        output: null,
      };

      ctx.metrics.stageResults.set(stage.id, stageResult);
      emitStep(ctx, stage.id, `Something went wrong|||${stage.name} failed`, `Error: ${errorMsg}`);

      if (stage.critical) {
        throw new Error(`Critical stage "${stage.name}" failed: ${errorMsg}`);
      }

      return stageResult;
    }
  }
  const errMsg = lastErr instanceof Error ? (lastErr as Error).message : String(lastErr);
  throw new Error(`Stage "${stage.name}" exhausted all retries: ${errMsg}`);
}

// ── RuFlo Fusion bridge (gated by RUFLO_ENABLED=1) ─────────────────────
// When the env flag is set, delegate to the 10-agent RuFlo pipeline and
// adapt its DeliveryReport into the existing OrchestrationResult shape so
// downstream callers (routes/autocoder.ts, frontend) keep working without
// changes. With the flag off, the legacy enrichment + generation flow runs.
// Per-conversation delivery-report cache (bounded LRU). Keyed by
// conversation id when the caller threads one through `understanding`.
const __ruFloReports = new Map<string, import('./ruflo/index.js').DeliveryReport>();
const __RUFLO_REPORT_LIMIT = 50;
function rememberRuFloReport(id: string, report: import('./ruflo/index.js').DeliveryReport): void {
  if (__ruFloReports.size >= __RUFLO_REPORT_LIMIT) {
    const firstKey = __ruFloReports.keys().next().value;
    if (firstKey !== undefined) __ruFloReports.delete(firstKey);
  }
  __ruFloReports.set(id, report);
}
export function getRuFloReport(id: string): import('./ruflo/index.js').DeliveryReport | null {
  return __ruFloReports.get(id) ?? null;
}
export function getLastRuFloReport(): import('./ruflo/index.js').DeliveryReport | null {
  const keys = [...__ruFloReports.keys()];
  return keys.length === 0 ? null : __ruFloReports.get(keys[keys.length - 1]) ?? null;
}

/**
 * Deep planning enrichment — replays legacy stages 3, 3a-3e (entity
 * intelligence, UX flows, integrations, security plan, performance plan,
 * learned-pattern application) BEFORE the Architect agent runs. Each step
 * is best-effort and writes its result back onto ctx so wrapped modules
 * (planArchitecture, generateProjectFromPlan, etc.) see the enriched plan.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runDeepPlanningEnrichment(ctx: any, plan: ProjectPlan): Promise<void> {
  const userDescription =
    plan.projectDescription || ctx.userRequest || plan.projectName || '';

  // Stage 3 — apply patterns learned from past generations.
  try {
    const le = await import('./generation-learning-engine.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enriched = (le as any).learningEngine.applyLearnedPatterns(plan);
    if (enriched && typeof enriched === 'object') {
      ctx.plan = enriched;
    }
  } catch (e) {
    console.warn('[RuFlo:enrich] learningEngine.applyLearnedPatterns failed:', (e as Error).message);
  }

  // Stage 3a — Entity Intelligence: infer fields + relationships per entity.
  // Writes enrichments back into ctx.plan so wrapped modules
  // (planArchitecture, designSchema, generateProjectFromPlan, …) see them.
  try {
    const efi = await import('./entity-field-inference.js');
    const dataModel = Array.isArray(ctx.plan?.dataModel) ? ctx.plan.dataModel : [];
    const entityNames = dataModel.map((e: { name?: string }) => e?.name).filter((n: unknown): n is string => typeof n === 'string' && n.length > 0);
    if (entityNames.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inferred = (efi as any).inferEntityFields(entityNames, ctx.detectedDomain) as Array<{ name: string; fields?: unknown[]; relationships?: unknown[] }>;
      if (Array.isArray(inferred) && inferred.length > 0) {
        const byName = new Map(inferred.map((i) => [i.name, i]));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx.plan.dataModel = dataModel.map((e: any) => {
          const inf = byName.get(e?.name);
          if (!inf) return e;
          const existingFields = new Set((Array.isArray(e.fields) ? e.fields : []).map((f: { name?: string }) => f?.name));
          const newFields = (Array.isArray(inf.fields) ? inf.fields : []).filter((f) => {
            const name = (f as { name?: string })?.name;
            return typeof name === 'string' && !existingFields.has(name);
          });
          // ArchetypeRelationship shape: { entity, type, field? }. Dedupe key
          // covers all three so a "many-to-one Author via authorId" does not
          // collapse with "one-to-many Comment via postId".
          const relKey = (r: { entity?: string; type?: string; field?: string }) =>
            `${r?.entity ?? ''}|${r?.type ?? ''}|${r?.field ?? ''}`;
          const existingRels = new Set(
            (Array.isArray(e.relationships) ? e.relationships : []).map((r: { entity?: string; type?: string; field?: string }) => relKey(r)),
          );
          const newRels = (Array.isArray(inf.relationships) ? inf.relationships : []).filter((r) =>
            !existingRels.has(relKey(r as { entity?: string; type?: string; field?: string })),
          );
          return {
            ...e,
            fields: [...(Array.isArray(e.fields) ? e.fields : []), ...newFields],
            relationships: [...(Array.isArray(e.relationships) ? e.relationships : []), ...newRels],
          };
        });
      }
      // Cross-entity relationships (legacy parity with stage 3a).
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const crossRels = (efi as any).inferRelationshipsForEntities(entityNames);
        if (Array.isArray(crossRels) && crossRels.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (ctx.plan as any)._inferredRelationships = crossRels;
        }
      } catch {/* best-effort */}
    }
  } catch (e) {
    console.warn('[RuFlo:enrich] inferEntityFields failed:', (e as Error).message);
  }

  // Stage 3b — UX Flow Planning. Writes both uxFlows and errorHandling
  // onto the plan so generators read them from the canonical location.
  try {
    const ux = await import('./ux-flow-planner.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uxResult = (ux as any).planUXFlows(ctx.plan);
    if (uxResult?.uxFlows) ctx.plan.uxFlows = uxResult.uxFlows;
    if (uxResult?.errorHandling) ctx.plan.errorHandling = uxResult.errorHandling;
    ctx.uxFlows = uxResult; // legacy mirror for any reader expecting ctx.uxFlows
  } catch (e) {
    console.warn('[RuFlo:enrich] planUXFlows failed:', (e as Error).message);
  }

  // Stage 3c — Integration Detection.
  try {
    const ip = await import('./integration-planner.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const integrations = (ip as any).planIntegrations(ctx.plan, userDescription);
    if (Array.isArray(integrations)) ctx.plan.integrations = integrations;
    ctx.integrations = integrations; // legacy mirror
  } catch (e) {
    console.warn('[RuFlo:enrich] planIntegrations failed:', (e as Error).message);
  }

  // Stage 3d — Security Planning (auth strategy + permissions; distinct
  // from the Security agent which scans the generated code for vulns).
  try {
    const sp = await import('./security-planner.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const security = (sp as any).planSecurity(ctx.plan, userDescription);
    if (security) ctx.plan.securityPlan = security;
    ctx.securityPlan = security; // legacy mirror
  } catch (e) {
    console.warn('[RuFlo:enrich] planSecurity failed:', (e as Error).message);
  }

  // Stage 3e — Performance Planning (pagination, caching, indexes).
  try {
    const pp = await import('./performance-planner.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perf = (pp as any).planPerformance(ctx.plan);
    if (perf) ctx.plan.performancePlan = perf;
    ctx.performancePlan = perf; // legacy mirror
  } catch (e) {
    console.warn('[RuFlo:enrich] planPerformance failed:', (e as Error).message);
  }
}

/**
 * Post-RuFlo deep quality + learning + plugins. Mirrors legacy stages 16
 * (deep quality 5 passes), 17 (learning record), and the plugin hook.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runPostRuFloEnhancements(ctx: any): Promise<void> {
  // ── Stage 16 — Deep Quality Analysis (5 passes).
  if (Array.isArray(ctx.files) && ctx.files.length > 0) {
    try {
      const cfv = await import('./cross-file-validator.js');
      const consistency = (cfv as any).validateCrossFileConsistency(ctx.files);
      if (consistency?.fixes?.length > 0) {
        try {
          const ep = await import('./enhancement-patch.js');
          const patch = (cfv as any).buildConsistencyEnhancementPatch(ctx.files, consistency.fixes);
          (ep as any).applyEnhancementPatches(ctx, [patch], { stagePhase: 'deep-quality' });
        } catch (e) {
          console.warn('[RuFlo:deep-quality] consistency apply failed:', (e as Error).message);
        }
      }
      ctx.consistencyReport = consistency;
    } catch (e) {
      console.warn('[RuFlo:deep-quality] cross-file consistency failed:', (e as Error).message);
    }
    try {
      const chp = await import('./code-hardening-pass.js');
      const hardening = (chp as any).hardenGeneratedCode(ctx.files);
      if (hardening?.fixes?.length > 0) {
        try {
          const ep = await import('./enhancement-patch.js');
          const patch = (chp as any).buildHardeningEnhancementPatch(ctx.files, hardening.fixes);
          (ep as any).applyEnhancementPatches(ctx, [patch], { stagePhase: 'deep-quality' });
        } catch (e) {
          console.warn('[RuFlo:deep-quality] hardening apply failed:', (e as Error).message);
        }
      }
      ctx.hardeningReport = hardening;
    } catch (e) {
      console.warn('[RuFlo:deep-quality] hardening failed:', (e as Error).message);
    }
    try {
      const tcv = await import('./type-contract-verifier.js');
      ctx.typeContractReport = (tcv as any).verifyTypeContracts(ctx.files);
    } catch (e) {
      console.warn('[RuFlo:deep-quality] type-contract verify failed:', (e as Error).message);
    }
    try {
      const aps = await import('./anti-pattern-scanner.js');
      ctx.antiPatternReport = (aps as any).scanAntiPatterns(ctx.files);
    } catch (e) {
      console.warn('[RuFlo:deep-quality] anti-pattern scan failed:', (e as Error).message);
    }
    try {
      const qse = await import('./quality-scoring-engine.js');
      ctx.qualityScoreReport = (qse as any).scoreProjectQuality(ctx.files, {
        consistency: ctx.consistencyReport,
        hardening: ctx.hardeningReport,
        typeContracts: ctx.typeContractReport,
        antiPatterns: ctx.antiPatternReport,
      });
    } catch (e) {
      console.warn('[RuFlo:deep-quality] quality scoring failed:', (e as Error).message);
    }
  }

  // ── Plugins: post-generate enhancement patches.
  try {
    const loader = await import('./plugins/loader.js');
    const ep = await import('./enhancement-patch.js');
    const pluginRun = await (loader as any).runPluginsForHook('post-generate', ctx);
    if (pluginRun?.patches?.length > 0) {
      (ep as any).applyEnhancementPatches(ctx, pluginRun.patches, { stagePhase: 'plugin' });
    }
    if (pluginRun?.audit) {
      (ctx as any).pluginAudit = pluginRun.audit;
    }
  } catch (e) {
    // Plugin loader is optional; log so parity regressions are not hidden.
    console.warn('[RuFlo:plugins] runPluginsForHook(post-generate) failed:', (e as Error).message);
  }

  // Lifecycle parity: Reviewer (Stage 13 quality patches) and the
  // deep-quality consistency/hardening passes mutate ctx.files AFTER the
  // Debugger ran. Re-run a final validate-and-fix pass so any patches
  // applied above are re-validated, mirroring the legacy
  // Stage 16 → trailing Stage 15 drain semantics.
  if (Array.isArray(ctx.files) && ctx.files.length > 0) {
    try {
      const v = await import('./post-generation-validator.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (v as any).validateAndFix(ctx.files, 1);
      if (result?.files && Array.isArray(result.files) && result.files.length > 0) {
        ctx.files = result.files;
      }
      ctx.postPipelineValidation = result;
    } catch (e) {
      console.warn('[RuFlo:post-validate] final validateAndFix failed (non-fatal):', (e as Error).message);
    }
  }
}

/**
 * Post-RuFlo learning recorder. Mirrors legacy stage 17.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runPostRuFloLearning(ctx: any, qualityScore: number, success: boolean): Promise<void> {
  try {
    const le = await import('./generation-learning-engine.js');
    await (le as any).learningEngine.recordGenerationOutcome({
      plan: ctx.plan,
      files: ctx.files,
      success,
      qualityScore,
      actions: ctx.actions ?? [],
    });
  } catch (e) {
    console.warn('[RuFlo:learn] recordGenerationOutcome failed:', (e as Error).message);
  }
  try {
    if (ctx.complexityProfile) {
      const cls = await import('./complexity-learning-store.js');
      const cc = await import('./complexity-classifier.js');
      const sigDesc = [ctx.userRequest, ctx.plan?.projectName, ctx.plan?.projectDescription].filter(Boolean).join(' ');
      const lineCount = (ctx.files as Array<{ content?: string }>).reduce(
        (n, f) => n + (typeof f.content === 'string' ? f.content.split('\n').length : 0),
        0,
      );
      (cls as any).recordComplexityOutcome({
        signature: (cc as any).complexitySignature(sigDesc, null),
        finalTier: ctx.complexityProfile.tier,
        fileCount: ctx.files.length,
        lineCount,
        success,
      });
    }
  } catch (e) {
    console.warn('[RuFlo:learn] recordComplexityOutcome failed:', (e as Error).message);
  }
}

async function runRuFloAdapter(
  plan: ProjectPlan,
  understanding: UnderstandingResult | undefined,
  onStep: OnStepCallback | undefined,
): Promise<OrchestrationResult> {
  const { runRuFloPipeline } = await import('./ruflo/index.js');
  const start = Date.now();
  const ctx: PipelineContext = {
    userRequest: understanding?.level1_intent?.primaryGoal || plan.projectName || '',
    understanding,
    plan,
    files: [],
    testFiles: [],
    slmStagesRun: [],
    slmHealth: [],
    metrics: createEmptyMetrics(),
    thinkingSteps: [],
    onStep,
    actions: [],
  };

  // Pre-RuFlo: derive detectedDomain + reasoning so wrapped modules
  // (planArchitecture, designSchema, designAPI, generateProjectFromPlan,
  // generateTestFiles, etc.) have the inputs they expect.
  ctx.detectedDomain =
    understanding?.level2_domain?.primaryDomain?.id
    ?? understanding?.level2_domain?.primaryDomain?.name?.toLowerCase()?.replace(/\s+/g, '-');
  try {
    const cre = await import('./contextual-reasoning-engine.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.reasoning = (cre as any).analyzeSemantics(plan);
  } catch (e) {
    console.warn('[RuFlo] analyzeSemantics failed (non-fatal):', (e as Error).message);
  }

  // Deep planning enrichment — preserves legacy stages 3, 3a-3e that ran
  // BEFORE Architect. These mutate `ctx.plan` so every downstream agent
  // sees the same enriched plan (entity fields, UX flows, integrations,
  // security plan, performance plan). All best-effort; never fatal.
  await runDeepPlanningEnrichment(ctx, plan);

  emitStep(ctx, 'orchestrator', 'RuFlo pipeline starting|||10-agent sequential pipeline',
    [
      `Project: "${plan.projectName}" · domain: ${ctx.detectedDomain ?? 'general'} · complexity tier: ${ctx.complexityProfile?.tier ?? 'auto'}.`,
      'Architecture: 10 specialist agents run sequentially, each writes to a shared ExecutiveMemory.',
      'Contracts: hard gates after Architect (planner→architect coverage) and Designer (system→designer coverage) re-run upstream agents up to 3× if outputs disagree.',
      'Inputs into the pipeline: enriched plan (modules, dataModel, apiEndpoints, pages, workflows, roles, securityPlan, performancePlan), the user understanding, and any cached agent outputs from prior runs.',
      'Outputs you will see: source files, test files, repair diffs, security report, quality score, and a per-agent intel summary in the steps below.',
    ].join('\n'));

  // Per-agent friendly labels + a short "what's happening now" detail
  // shown when the user expands the active step. Keeps the chat readable
  // while the technical name (after `|||`) and the start/done details
  // carry the substance for power users.
  const AGENT_FRIENDLY: Record<string, { active: string; done: string; doing: string }> = {
    Queen:     {
      active: 'Locking the spec',       done: 'Spec locked',
      doing: 'Reading the user prompt + understanding result and freezing the canonical TaskSpec (domain, primary user, must/should/could features, core user flow). All downstream agents read from this contract.',
    },
    Planner:   {
      active: 'Planning features',      done: 'Plan ready',
      doing: 'Expanding the TaskSpec into a feature backlog with acceptance criteria, priority (must/should/could), explicit requirements, and a todo list sized for the complexity tier.',
    },
    Architect: {
      active: 'Mapping architecture',   done: 'Architecture mapped',
      doing: 'Grouping features into modules, choosing the tech stack, building the file dependency graph, and producing the layout that the contract gate will verify (every feature owned by exactly one module).',
    },
    System:    {
      active: 'Designing data + API',   done: 'Data layer designed',
      doing: 'Defining data models, DB tables (fields, types, indexes, relationships), REST endpoints (method/path/auth/validation/response shape), and business rules.',
    },
    Designer:  {
      active: 'Drafting UI components', done: 'UI drafted',
      doing: 'Composing the component tree, page layouts, and the design tokens (colors, spacing, typography). Contract gate verifies every component reads from a real System data model.',
    },
    Coder:     {
      active: 'Writing code',           done: 'Code written',
      doing: 'Generating actual source files for routes, handlers, components, hooks, and shared schemas — using the Architect graph + System APIs + Designer tokens as the input contract.',
    },
    Debugger:  {
      active: 'Hunting bugs',           done: 'Debug pass complete',
      doing: 'Validating imports/exports/types across all files, repairing missing pieces in-place (validateAndFix), and recording every patch as a repair diff so you can see what changed.',
    },
    Security:  {
      active: 'Auditing security',      done: 'Security audited',
      doing: 'Static-scanning generated code for missing input validation, unauthenticated mutating routes, leaked secrets, dangerous CORS, dependency advisories, and unsafe DOM sinks.',
    },
    Reviewer:  {
      active: 'Reviewing quality',      done: 'Review complete',
      doing: 'Scoring the result 0–100 against contract adherence, code clarity, test-coverage hooks, accessibility hints, and performance affordances. Annotates files with notes.',
    },
    Tester:    {
      active: 'Generating tests',       done: 'Tests generated',
      doing: 'Synthesising API route tests (happy + error paths) and component smoke tests using the System spec — runnable with the project test command.',
    },
  };

  const report = await runRuFloPipeline({
    prompt: ctx.userRequest,
    legacyCtx: ctx,
    onAgentEvent: (agent, phase, summary) => {
      const f = AGENT_FRIENDLY[agent] ?? { active: agent, done: agent, doing: '' };
      if (phase === 'start') {
        emitStep(ctx, 'ruflo', `${f.active}…|||RuFlo ${agent} starting`,
          f.doing || `Running the ${agent} agent…`);
      } else if (phase === 'complete') {
        emitStep(ctx, 'ruflo', `${f.done}|||RuFlo ${agent} complete`, summary ?? '');
      } else if (phase === 'skipped') {
        emitStep(ctx, 'ruflo', `${f.done} (cached)|||RuFlo ${agent} skipped`,
          `${agent} output is still valid from a prior run (no upstream invalidation), so its memory entry was reused as-is to save time and tokens.`);
      } else {
        emitStep(ctx, 'ruflo', `${agent} timed out|||RuFlo ${agent} halt`,
          `The ${agent} agent exceeded its health budget and was halted. Pipeline will continue with whatever earlier agents produced; downstream contract gates may flag missing outputs.`);
      }
    },
  });
  // Conversation id is best-effort — falls back to project name when absent.
  const conversationId =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((understanding as any)?.conversationId as string | undefined) ??
    plan.projectName ??
    'unknown';
  rememberRuFloReport(conversationId, report);

  // Authoritative file set comes from ctx.files (Debugger mutates these
  // in-place via validateAndFix — including newly created/large files
  // that the diff-based merge in sequential-controller would drop).
  // Fall back to report.sourceFiles only if ctx.files is empty.
  if (!ctx.files || ctx.files.length === 0) {
    ctx.files = Object.entries(report.sourceFiles).map(([path, content]) => ({
      path, content, language: path.split('.').pop() || '',
    }));
  }
  if (!ctx.testFiles || ctx.testFiles.length === 0) {
    ctx.testFiles = Object.entries(report.testFiles).map(([path, content]) => ({
      path, content, language: path.split('.').pop() || '',
    }));
  }

  // Post-RuFlo enhancements: legacy stages 16 (deep-quality 5 passes) +
  // plugin hook. These run AFTER the Debugger so cross-file consistency,
  // hardening, type-contracts, anti-patterns, and quality scoring see
  // the final repaired code.
  await runPostRuFloEnhancements(ctx);

  // Stage 17 — record this generation's outcome into the learning store
  // so future similar requests start from a stronger baseline. Prefer the
  // deep-quality (Stage 16) authoritative score when available, else fall
  // back to the ship-gate score.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deepScore = (ctx as any).qualityScoreReport?.overall;
  const finalScore = typeof deepScore === 'number' ? Math.round(deepScore) : report.qualityScore;
  ctx.metrics.overallScore = finalScore;
  await runPostRuFloLearning(ctx, finalScore, report.ok);

  ctx.metrics.totalDurationMs = Date.now() - start;
  ctx.metrics.fileCount = ctx.files.length;

  {
    const completedAgents = Object.keys(report.agentTimings).length;
    const slowest = Object.entries(report.agentTimings)
      .sort((a, b) => (b[1] as number) - (a[1] as number))[0];
    const totalAgentMs = Object.values(report.agentTimings).reduce((n, ms) => n + (ms as number), 0);
    const sevCount: Record<string, number> = {};
    for (const s of report.securityIssues) sevCount[s.severity] = (sevCount[s.severity] ?? 0) + 1;
    const sevLine = Object.entries(sevCount).map(([s, n]) => `${n} ${s}`).join(' / ') || 'none';
    const completeDetail = [
      `Agents completed: ${completedAgents}/10 in ${(totalAgentMs / 1000).toFixed(1)}s of agent time (${((Date.now() - start) / 1000).toFixed(1)}s wall clock).`,
      slowest ? `Slowest agent: ${slowest[0]} (${(((slowest[1] as number)) / 1000).toFixed(2)}s)` : '',
      `Files generated: ${report.filesGenerated} · final quality score: ${report.qualityScore}/100.`,
      `Self-repair: ${report.repairAttemptsUsed} repair attempts used · ${report.fallbacksTriggered} template fallbacks triggered.`,
      `Security issues: ${report.securityIssues.length} (${sevLine}).`,
      report.errors.length > 0 ? `Pipeline errors: ${report.errors.slice(0, 3).join(' | ')}` : 'No pipeline errors.',
      'Post-RuFlo enhancements (deep-quality 5-pass, plugin hooks) and the learning-store record-outcome already ran before this summary — final score reflects them.',
    ].filter(Boolean).join('\n');
    emitStep(ctx, 'orchestrator', `RuFlo complete|||${report.filesGenerated} files, score ${report.qualityScore}`, completeDetail);
  }

  return {
    success: report.ok,
    files: ctx.files,
    testFiles: ctx.testFiles,
    context: ctx,
    metrics: ctx.metrics,
    summary: {
      totalStages: 10,
      completedStages: Object.keys(report.agentTimings).length,
      failedStages: report.errors.map((e) => e.split(']')[0].replace('[', '')),
      skippedStages: [],
      overallQuality: report.qualityScore,
      highlights: [
        `${report.filesGenerated} files generated`,
        `${report.repairAttemptsUsed} repairs applied`,
        `${report.fallbacksTriggered} template fallbacks`,
      ],
      warnings: report.securityIssues.map((s) => `[${s.severity}] ${s.message}`),
    },
    // Forward agent-produced downstream signals so callers reading the
    // top-level result (not result.context) keep working post-fusion.
    snapshotHash: (ctx as any).snapshotHash || null,
    slmHealth: ctx.slmHealth || [],
    complexityProfile: ctx.complexityProfile,
    generationMode: ctx.generationMode,
    generationBudget: ctx.generationBudget,
    projectGraph: ctx.projectGraph,
    graphVerification: ctx.graphVerification,
    semanticValidation: ctx.semanticValidation,
    repairAudit: ctx.repairAudit,
    pluginAudit: (ctx as any).pluginAudit,
  };
}

export async function orchestrateGeneration(plan: ProjectPlan, understanding?: UnderstandingResult, onStep?: OnStepCallback): Promise<OrchestrationResult> {
  // RuFlo Fusion is the pipeline now — every AutoCoder generation runs
  // through the 10-agent controller. Each agent wraps the corresponding
  // AutoCoder module (Architect→planArchitecture, System→designSchema+designAPI,
  // Coder→generateProjectFromPlan, Debugger→validateAndFix, etc.) and writes
  // its result back into PipelineContext so downstream consumers stay intact.
  return runRuFloAdapter(plan, understanding, onStep);
}

export function orchestratePlanning(understanding: UnderstandingResult): { plan: ProjectPlan; thinkingSteps: ThinkingStep[] } {
  const thinkingSteps: ThinkingStep[] = [];
  const emit = (phase: string, label: string, detail?: string) => {
    thinkingSteps.push({ phase, label, detail, timestamp: Date.now() });
  };

  emit('orchestrator', 'Creating your project plan|||Planning pipeline activated', 'Running planning stages');

  let plan = generatePlan(understanding);
  emit('planning', 'Plan created|||Project plan created', `${plan.dataModel?.length || 0} entities, ${plan.pages?.length || 0} pages`);

  if (plan._domainCoverage && !plan._domainCoverage.isSufficient) {
    emit('planning', `Domain coverage warning|||${plan._domainCoverage.coveredDomains}/${plan._domainCoverage.totalDomains} domains covered`, 
      `Coverage: ${Math.round(plan._domainCoverage.coverageScore * 100)}% — some requested domains may lack full representation`);
  }

  // Stage 3a: Entity Intelligence — upgrade generic entities with archetype fields
  try {
    const entityNames = plan.dataModel.map(e => e.name);
    const detectedDomainId = understanding?.level2_domain?.primaryDomain?.id;
    const inferredEntities = inferEntityFields(entityNames, detectedDomainId);
    let upgraded = 0;
    for (const entity of plan.dataModel) {
      const inferred = inferredEntities.find(e => e.name === entity.name);
      if (inferred && inferred.matchConfidence > 0.5) {
        const existingFieldNames = new Set(entity.fields.map(f => f.name));
        for (const af of inferred.fields) {
          if (!existingFieldNames.has(af.name) && !isSemanticDuplicate(af.name, existingFieldNames)) {
            entity.fields.push({ name: af.name, type: af.type, required: af.required || false, description: af.description });
          }
        }
        if (inferred.relationships) {
          const existingRels = new Set(entity.relationships.map(r => r.entity));
          for (const rel of inferred.relationships) {
            if (!existingRels.has(rel.entity)) {
              entity.relationships.push({ entity: rel.entity, type: rel.type, field: rel.field || '' });
            }
          }
        }
        upgraded++;
      }
    }
    emit('planning', 'Data model improved|||Entity Intelligence complete', `Upgraded ${upgraded}/${plan.dataModel.length} entities with domain-specific fields`);
  } catch (e) {
    emit('planning', 'Skipping data upgrade|||Entity Intelligence skipped', 'Field inference unavailable');
  }

  const reasoning = analyzeSemantics(plan);
  plan = enrichPlanWithReasoning(plan, reasoning);
  emit('reasoning', 'Deep analysis complete|||Semantic analysis complete', `${reasoning.relationships.length} relationships, ${reasoning.businessRules.length} rules`);

  // Stage 3b: UX Flow Planning
  try {
    const uxResult = planUXFlows(plan);
    plan.uxFlows = uxResult.uxFlows;
    plan.errorHandling = uxResult.errorHandling;
    emit('planning', 'User experience designed|||UX flows planned', `${uxResult.uxFlows.length} user flows | ${uxResult.errorHandling.pageStates.length} page states`);
  } catch (e) {
    emit('planning', 'Skipping UX flows|||UX flow planning skipped', 'UX planner unavailable');
  }

  // Stage 3c: Integration Detection
  try {
    const userDesc = plan.overview || '';
    const integrations = planIntegrations(plan, userDesc);
    if (integrations.length > 0) {
      plan.integrations = integrations;
      emit('planning', 'Services identified|||Integrations detected', `${integrations.length}: ${integrations.map(i => i.name).join(', ')}`);
    }
  } catch (e) {
    emit('planning', 'Skipping integrations|||Integration detection skipped', 'Integration planner unavailable');
  }

  // Stage 3d: Security Planning
  try {
    const security = planSecurity(plan, plan.overview || '');
    plan.securityPlan = security;
    emit('planning', 'Security set up|||Security plan complete', `Auth: ${security.authStrategy} | ${security.roleHierarchy.length} roles | ${security.entityPermissions.length} permissions`);
  } catch (e) {
    emit('planning', 'Skipping security|||Security planning skipped', 'Security planner unavailable');
  }

  // Stage 3e: Performance Planning
  try {
    const perf = planPerformance(plan);
    plan.performancePlan = perf;
    emit('planning', 'Speed optimizations set|||Performance plan complete', `${perf.pagination.length} pagination | ${perf.caching.length} cache | ${perf.indexRecommendations.length} indexes`);
  } catch (e) {
    emit('planning', 'Skipping optimizations|||Performance planning skipped', 'Performance planner unavailable');
  }

  return { plan, thinkingSteps };
}

function computeOverallScore(ctx: PipelineContext): number {
  const results = Array.from(ctx.metrics.stageResults.values());
  if (results.length === 0) return 0;
  const totalWeight = results.reduce((sum, r) => {
    const stage = PIPELINE_STAGES.find(s => s.id === r.stageId);
    return sum + (stage?.critical ? 2 : 1);
  }, 0);
  const weightedSum = results.reduce((sum, r) => {
    const stage = PIPELINE_STAGES.find(s => s.id === r.stageId);
    const weight = stage?.critical ? 2 : 1;
    return sum + r.qualityScore * weight;
  }, 0);
  return Math.round(weightedSum / totalWeight);
}

function buildSummary(ctx: PipelineContext, failedStages: string[], skippedStages: string[]): PipelineSummary {
  const completedStages = Array.from(ctx.metrics.stageResults.values()).filter(r => r.success).length;
  const overallQuality = computeOverallScore(ctx);

  const highlights: string[] = [];
  const warnings: string[] = [];

  if (ctx.architecture) highlights.push(`Architecture: ${ctx.architecture.pattern} pattern`);
  if (ctx.designSystem) highlights.push(`Design: ${ctx.designSystem.name} theme`);
  if (ctx.schemaDesign) highlights.push(`Schema: ${ctx.schemaDesign.tables?.length || 0} tables designed`);
  if (ctx.apiDesign) highlights.push(`API: ${ctx.apiDesign.routes?.length || 0} endpoints designed`);
  if (ctx.componentTree) highlights.push(`UI: ${ctx.componentTree.components?.length || 0} components composed`);
  highlights.push(`Generated: ${ctx.metrics.fileCount} files, ~${ctx.metrics.lineCount} lines`);

  if (failedStages.length > 0) warnings.push(`Failed stages: ${failedStages.join(', ')}`);
  if (overallQuality < 70) warnings.push('Overall quality below 70 - consider reviewing');

  const failedCriticalGates: string[] = [];
  const failedNonCriticalGates: string[] = [];
  for (const gate of ctx.metrics.qualityGates) {
    if (!gate.passed) {
      const stage = PIPELINE_STAGES.find(s => s.id === gate.stageId);
      const label = `${gate.stageId} (${gate.score}/${gate.threshold})`;
      if (stage?.critical) {
        failedCriticalGates.push(label);
      } else {
        failedNonCriticalGates.push(label);
      }
    }
  }
  if (failedCriticalGates.length > 0) {
    warnings.push(`Critical quality gates failed: ${failedCriticalGates.join(', ')} — review recommended`);
  }
  if (failedNonCriticalGates.length > 0) {
    warnings.push(`Non-critical quality gates failed: ${failedNonCriticalGates.join(', ')}`);
  }

  return {
    totalStages: PIPELINE_STAGES.length,
    completedStages,
    failedStages,
    skippedStages,
    overallQuality,
    highlights,
    warnings,
  };
}

function inferComputedFieldType(computed: ComputedField): string {
  const expr = computed.expression.toLowerCase();
  const name = computed.fieldName.toLowerCase();
  const desc = computed.description.toLowerCase();
  const combined = `${expr} ${name} ${desc}`;

  if (/count|sum|total|average|avg|length|quantity|qty|number|amount|price|cost|subtotal|grand|billable|\.length/.test(combined)) {
    return 'number';
  }

  if (/date|timestamp|time|created|updated|deadline|schedule/.test(combined)) {
    return 'datetime';
  }

  if (/\bis\b|\bhas\b|\bcan\b|\benabled\b|\bactive\b|\bcompleted\b|\bvalid\b|\bboolean\b/.test(combined)) {
    return 'boolean';
  }

  return 'text';
}

function enrichPlanWithReasoning(plan: ProjectPlan, reasoning: ReasoningResult): ProjectPlan {
  const enriched = { ...plan, dataModel: plan.dataModel.map(e => ({ ...e, fields: [...e.fields], relationships: [...e.relationships] })) };

  for (const rel of reasoning.relationships) {
    const entity = enriched.dataModel.find(e => e.name === rel.from);
    if (entity) {
      const existingRel = entity.relationships.find(r => r.entity === rel.to);
      if (!existingRel) {
        entity.relationships.push({
          entity: rel.to,
          type: rel.cardinality === '1:N' ? 'one-to-many' : rel.cardinality === 'N:1' ? 'many-to-one' : rel.type,
          field: rel.fromField,
        });
      }
    }
  }

  for (const computed of reasoning.computedFields) {
    const entity = enriched.dataModel.find(e => e.name === computed.entityName);
    if (entity && !entity.fields.find(f => f.name === computed.fieldName)) {
      entity.fields.push({
        name: computed.fieldName,
        type: inferComputedFieldType(computed),
        required: false,
        description: `Computed: ${computed.description}`,
      });
    }
  }

  for (const uiPattern of reasoning.uiPatterns) {
    const page = enriched.pages.find(p =>
      p.dataNeeded.includes(uiPattern.entityName) ||
      p.name.toLowerCase().includes(uiPattern.entityName.toLowerCase())
    );
    if (page) {
      const featureLabel = `${uiPattern.pattern} view`;
      if (!page.features.includes(featureLabel)) {
        page.features.push(featureLabel);
      }
    }
  }

  return enriched;
}

export function getPipelineStages(): PipelineStage[] {
  return [...PIPELINE_STAGES];
}

export function getStageDescription(stageId: string): PipelineStage | undefined {
  return PIPELINE_STAGES.find(s => s.id === stageId);
}