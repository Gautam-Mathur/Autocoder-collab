/**
 * Orchestration — Formatter (Task #18 split).
 *
 * Pure formatting helpers shared across routes/autocoder.ts and
 * conversation-phase-handler.ts. Keeps the chat-response markdown
 * construction in one place so future tweaks (e.g. new sections, different
 * grading) don't have to be hunted across two large files.
 */

import type {
  GraphVerificationResult,
  ProjectGraph,
} from '../project-graph/index.js';

/** Letter grade from a 0-100 score, matching the existing chat formatter. */
export function gradeFromScore(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  if (score > 0) return 'F';
  return '';
}

/** Single-line "graph health" badge for the chat reply footer. */
export function formatGraphHealthLine(verification?: GraphVerificationResult): string {
  if (!verification) return '';
  if (verification.passed) {
    return `**Graph:** ${verification.stats.files} files / ${verification.stats.routesRegistered} routes / ${verification.stats.apiCalls} api calls — fully resolved`;
  }
  return `**Graph:** ${verification.totalIssues} issue(s) — ${verification.unresolvedImports.length} unresolved imports, ${verification.missingExports.length} missing exports, ${verification.missingRoutes.length} missing routes, ${verification.undeclaredDependencies.length} undeclared deps`;
}

/** Markdown block describing graph stats in detail (used by the report view). */
export function formatGraphReportBlock(graph?: ProjectGraph, verification?: GraphVerificationResult): string {
  if (!graph || !verification) return '';
  return [
    `### Project Graph`,
    `- Files indexed: **${graph.filesIndexed}**`,
    `- Components: **${graph.byKind.component.length}**, Hooks: **${graph.byKind.hook.length}**`,
    `- Backend routes: **${graph.byKind.route.length}**, API calls: **${graph.byKind['api-client'].length}**`,
    `- Edges: **${graph.edges.length}** (imports/exports/route-handlers/api-call-to-endpoint)`,
    verification.passed
      ? `- Verification: PASS`
      : `- Verification: ${verification.totalIssues} issue(s) — see auto-fix log`,
  ].join('\n');
}

/** Bullet list of files (capped) used in chat replies. */
export function formatFileList(files: { path: string }[], cap = 30): string {
  const head = files.slice(0, cap).map(f => `- \`${f.path}\``).join('\n');
  const extra = files.length > cap ? `\n- ...and ${files.length - cap} more files` : '';
  return head + extra;
}
