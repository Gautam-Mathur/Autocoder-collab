/**
 * REVIEWER — Quality scorer (Fusion mode, read-only).
 * Wraps AutoCoder's `code-quality-engine.analyzeCodeQuality`,
 * `project-graph.buildProjectGraph`, and `semantic-validator.validateSemantics`.
 * Combines their findings into RuFlo's qualityScore + annotations.
 *
 * Reads:  legacyCtx.files, legacyCtx.plan
 * Writes: ReviewerOutput { qualityScore, annotations }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import type { AgentRunContext } from '../agent-runner.js';
import type {
  Annotation,
  ArchitectOutput,
  CoderOutput,
  DebuggerOutput,
  ReviewerOutput,
  SecurityOutput,
} from '../types.js';

export async function runReviewer(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<ReviewerOutput> {
  const architect = ledger.read('Reviewer', 'architect') as ArchitectOutput | null;
  const coder     = ledger.read('Reviewer', 'coder')     as CoderOutput     | null;
  const security  = ledger.read('Reviewer', 'security')  as SecurityOutput  | null;
  const dbg       = ledger.read('Reviewer', 'debugger')  as DebuggerOutput  | null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = runCtx.legacyCtx as any | undefined;
  const annotations: Annotation[] = [];
  let score = 100;

  // Real quality engine — best-effort.
  if (ctx?.files && ctx?.plan) {
    try {
      const cq = await import('../../code-quality-engine.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = (cq as any).analyzeCodeQuality(ctx.files, ctx.plan, ctx.detectedDomain);
      ctx.qualityReport = report;

      // Stage 13 — apply quality auto-fixes via the enhancement-patch
      // applier. The applier runs dep/provider validation and writes back
      // into ctx.files (Reviewer is read-only for source truth, but the
      // legacy quality stage explicitly mutated files via this path).
      if (Array.isArray(report?.fixes) && report.fixes.length > 0) {
        try {
          const ep = await import('../../enhancement-patch.js');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const patch = (cq as any).buildQualityEnhancementPatch(ctx.files, report.fixes);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (ep as any).applyEnhancementPatches(ctx, [patch], { stagePhase: 'quality' });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[RuFlo:Reviewer] quality auto-fix apply failed:', (e as Error).message);
        }
      }

      if (typeof report?.overallScore === 'number') {
        score = Math.round(report.overallScore);
      }
      if (Array.isArray(report?.issues)) {
        for (const issue of report.issues.slice(0, 50)) {
          annotations.push({
            file: String(issue.file ?? '(unknown)'),
            note: String(issue.message ?? issue.description ?? 'Quality issue'),
            agent: 'Reviewer',
            severity: issue.severity === 'high' || issue.severity === 'critical' ? 'error' :
                      issue.severity === 'low' ? 'info' : 'warn',
          });
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[RuFlo:Reviewer] analyzeCodeQuality failed:', (e as Error).message);
    }

    // Build project graph + semantic validation.
    try {
      const pg = await import('../../project-graph/index.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const graph = (pg as any).buildProjectGraph(ctx.files);
      ctx.projectGraph = graph;
      try {
        const sv = await import('../../semantic-validator.js');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const semantic = (sv as any).validateSemantics(graph, ctx.files);
        ctx.semanticValidation = semantic;
        if (Array.isArray(semantic?.errors)) {
          for (const err of semantic.errors.slice(0, 20)) {
            annotations.push({
              file: String(err.file ?? '(unknown)'),
              note: String(err.message ?? 'Semantic error'),
              agent: 'Reviewer',
              severity: 'error',
            });
            score -= 2;
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[RuFlo:Reviewer] validateSemantics failed:', (e as Error).message);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[RuFlo:Reviewer] buildProjectGraph failed:', (e as Error).message);
    }
  }

  // Architect/Coder coverage check.
  if (architect && coder) {
    const generated = new Set(Object.keys(coder.sourceFiles));
    for (const node of architect.fileGraph) {
      if (!generated.has(node.file)) {
        annotations.push({
          file: node.file, note: 'Architect declared file but Coder did not emit it',
          agent: 'Coder', severity: 'warn',
        });
        score -= 1;
      }
    }
  }

  // Penalise security issues.
  if (security) {
    for (const issue of security.securityReport.issues) {
      annotations.push({
        file: issue.location ?? '(unknown)',
        note: issue.message,
        agent: 'Security',
        severity: issue.severity === 'critical' || issue.severity === 'high' ? 'error' : 'warn',
      });
      score -=
        issue.severity === 'critical' ? 15 :
        issue.severity === 'high'     ? 8  :
        issue.severity === 'medium'   ? 3  : 1;
    }
  }

  if (dbg && dbg.repairDiffs.length > 0) {
    annotations.push({
      file: '(multiple)',
      note: `${dbg.repairDiffs.length} files required surgical repair`,
      agent: 'Debugger', severity: 'info',
    });
  }

  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return { qualityScore: score, annotations };
}
