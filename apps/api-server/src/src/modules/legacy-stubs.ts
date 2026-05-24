/**
 * Legacy stubs — placeholders for the 17-stage pipeline modules that were
 * quarantined to /home/runner/workspace/AutoCoder/legacy/api-server-modules/
 * after the RuFlo Fusion 10-agent system became the canonical pipeline.
 *
 * Calling any of these stubs throws LegacyDisabledError. Route handlers
 * that exposed the legacy modules respond with HTTP 410 Gone and a pointer
 * to the restore-legacy backdoor script.
 *
 * Backdoor (single-command restore):
 *   bash AutoCoder/scripts/restore-legacy.sh
 *
 * That script copies the quarantined modules back into src/modules/, after
 * which `git checkout` of this file (and the routes/autocoder.ts edits)
 * fully reverts to the legacy pipeline.
 */

import type { Response } from 'express';

export class LegacyDisabledError extends Error {
  override name = 'LegacyDisabledError';
  constructor(public readonly endpoint: string) {
    super(
      `Legacy endpoint "${endpoint}" is disabled. The 17-stage pipeline has ` +
        `been replaced by the RuFlo Fusion 10-agent system. ` +
        `Run AutoCoder/scripts/restore-legacy.sh to re-enable.`,
    );
  }
}

export function respondLegacyDisabled(res: Response, endpoint: string): void {
  res.status(410).json({
    error: 'Legacy endpoint disabled',
    endpoint,
    replacement: 'POST /api/autocoder/generate (RuFlo pipeline)',
    restore: 'bash AutoCoder/scripts/restore-legacy.sh',
    message:
      'This route was part of the legacy 17-stage pipeline, which has been ' +
      'quarantined to AutoCoder/legacy/. RuFlo is now the only active pipeline.',
  });
}

// ----- Stub re-exports of the moved module symbols -----
// They preserve the original signatures so internal call sites still
// type-check, but throw at runtime if anyone forgets to gate the call.

export function generateProjectPlan(..._args: unknown[]): any {
  throw new LegacyDisabledError('planning-module.generateProjectPlan');
}
export function formatPlanAsMarkdown(..._args: unknown[]): any {
  throw new LegacyDisabledError('planning-module.formatPlanAsMarkdown');
}
export function generateProject(..._args: unknown[]): any {
  throw new LegacyDisabledError('advanced-code-generation.generateProject');
}
export function formatProjectAsTree(..._args: unknown[]): any {
  throw new LegacyDisabledError('advanced-code-generation.formatProjectAsTree');
}
export function formatProjectAsMarkdown(..._args: unknown[]): any {
  throw new LegacyDisabledError('advanced-code-generation.formatProjectAsMarkdown');
}
export function listBlueprints(..._args: unknown[]): any {
  throw new LegacyDisabledError('deep-project-generator.listBlueprints');
}
export function listFeatures(..._args: unknown[]): any {
  throw new LegacyDisabledError('deep-project-generator.listFeatures');
}
export function getBlueprint(..._args: unknown[]): any {
  throw new LegacyDisabledError('deep-project-generator.getBlueprint');
}
export function getFeature(..._args: unknown[]): any {
  throw new LegacyDisabledError('deep-project-generator.getFeature');
}
export function generatePlanFromCodebase(..._args: unknown[]): any {
  throw new LegacyDisabledError('reverse-plan-generator.generatePlanFromCodebase');
}
export function formatReversePlanSummary(..._args: unknown[]): any {
  throw new LegacyDisabledError('reverse-plan-generator.formatReversePlanSummary');
}
