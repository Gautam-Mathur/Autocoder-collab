/**
 * SLM Health Monitor
 *
 * Per-stage health checks for every SLM call made during code generation.
 * Each call gets:
 *   - a status: pass | degraded | fail | skipped
 *   - what the SLM actually did (e.g. "applied 3 of 5 schema patches")
 *   - latency + token cost
 *   - a friendly chat-ready message that goes straight to the thinking-steps UI
 *
 * Records are accumulated on `ctx.slmHealth` and exposed at the end of the
 * pipeline so the frontend can render a per-stage health summary.
 *
 * Use `runSLMWithHealth(ctx, stage, context, validate)` instead of `runSLM`
 * at every pipeline call site — it wraps the call, runs the per-stage
 * validator, records the result, and emits ONE consolidated thinking step
 * that says exactly what the SLM did (or did not do).
 */

import type { SLMResponse } from './slm-inference-engine.js';
import { runSLM, isSLMAvailable } from './slm-inference-engine.js';

export type SLMHealthStatus = 'pass' | 'degraded' | 'fail' | 'skipped';

export interface SLMValidation {
  /** True when the SLM produced a usable, contract-conforming output. */
  ok: boolean;
  /** Compact one-line description of what was applied (or attempted). */
  summary: string;
  /** How many proposed items were accepted (e.g. valid patches). */
  applied?: number;
  /** How many items the SLM proposed in total. */
  attempted?: number;
  /** Reasons the output failed or was downgraded; populated when ok=false. */
  reasons?: string[];
}

export interface SLMHealthRecord {
  stage: string;
  status: SLMHealthStatus;
  summary: string;
  applied?: number;
  attempted?: number;
  latencyMs: number;
  tokensUsed: number;
  reasons: string[];
  /** True when the rule-engine output was used in place of the SLM output. */
  fallbackUsed: boolean;
  timestamp: number;
}

/**
 * Minimal subset of the orchestrator's PipelineContext that the monitor needs.
 * Declared structurally so this module does not import from
 * pipeline-orchestrator.ts (which would create a cycle).
 */
export interface SLMHealthContextSlice {
  slmHealth?: SLMHealthRecord[];
  slmStagesRun?: string[];
  // Loose shape: matches the orchestrator's `ThinkingStep` (`timestamp`)
  // without importing it, to avoid creating an import cycle.
  onStep?: (step: any) => void;
  thinkingSteps?: any[];
}

const STATUS_ICON: Record<SLMHealthStatus, string> = {
  pass: '✓',
  degraded: '⚠',
  fail: '✗',
  skipped: '○',
};

const STAGE_FRIENDLY_NAME: Record<string, string> = {
  understand: 'Understanding AI',
  reason: 'Semantic AI',
  semantic: 'Semantic AI',
  design: 'Design AI',
  schema: 'Schema AI',
  api: 'API AI',
  compose: 'Components AI',
  components: 'Components AI',
  generate: 'Codegen AI',
  codegen: 'Codegen AI',
  quality: 'Quality AI',
};

function friendlyStageName(stage: string): string {
  return STAGE_FRIENDLY_NAME[stage] || `${stage} AI`;
}

function ensureHealthArray(ctx: SLMHealthContextSlice): SLMHealthRecord[] {
  if (!ctx.slmHealth) ctx.slmHealth = [];
  return ctx.slmHealth;
}

function emitHealthStep(
  ctx: SLMHealthContextSlice,
  stage: string,
  record: SLMHealthRecord,
): void {
  const icon = STATUS_ICON[record.status];
  const name = friendlyStageName(stage);
  const friendly = `${icon} ${name}: ${record.summary}`;
  const techParts: string[] = [
    `status=${record.status}`,
    `latency=${record.latencyMs}ms`,
  ];
  if (record.tokensUsed) techParts.push(`tokens=${record.tokensUsed}`);
  if (record.attempted !== undefined) {
    techParts.push(`applied=${record.applied ?? 0}/${record.attempted}`);
  }
  if (record.fallbackUsed) techParts.push('fallback=rules');
  const technical = `[${stage}] ${techParts.join(' ')}`;
  const detail = record.reasons.length > 0 ? record.reasons.join('; ') : undefined;

  const step = {
    phase: stage,
    label: `${friendly}|||${technical}`,
    detail,
    timestamp: Date.now(),
  };
  if (ctx.thinkingSteps) ctx.thinkingSteps.push(step);
  if (ctx.onStep) {
    try { ctx.onStep(step); } catch { /* never let UI emit fail */ }
  }
}

/**
 * Build a default validator from a known SLM response shape. Used when the
 * call site does not pass a custom validator.
 */
function defaultValidate<T>(response: SLMResponse<T>): SLMValidation {
  if (!response.success) {
    return {
      ok: false,
      summary: 'returned no usable output',
      reasons: [response.error || 'unknown error'],
    };
  }
  if (response.data === null || response.data === undefined) {
    return { ok: false, summary: 'returned empty data', reasons: ['data was null'] };
  }
  return { ok: true, summary: 'output accepted' };
}

export interface RunWithHealthOptions<T> {
  /** Per-stage validator; receives the SLM response and may inspect ctx data. */
  validate?: (response: SLMResponse<T>) => SLMValidation;
  /** Override SLM call (used in tests). */
  overrides?: Partial<{ maxTokens: number; temperature: number; timeoutMs: number }>;
}

/**
 * Wrap a runSLM call with per-stage health tracking.
 *
 * - If no SLM is available, records `skipped` and returns null data with
 *   `health.fallbackUsed = true`.
 * - Otherwise calls runSLM, runs the validator, records pass/degraded/fail.
 * - Always emits ONE consolidated thinking step describing what happened.
 */
export async function runSLMWithHealth<T = any>(
  ctx: SLMHealthContextSlice,
  stage: string,
  context: Record<string, any>,
  options: RunWithHealthOptions<T> = {},
): Promise<{ response: SLMResponse<T>; health: SLMHealthRecord }> {
  const records = ensureHealthArray(ctx);

  if (!isSLMAvailable()) {
    const record: SLMHealthRecord = {
      stage,
      status: 'skipped',
      summary: 'no AI model available — used rules',
      latencyMs: 0,
      tokensUsed: 0,
      reasons: ['SLM not configured'],
      fallbackUsed: true,
      timestamp: Date.now(),
    };
    records.push(record);
    emitHealthStep(ctx, stage, record);
    const empty: SLMResponse<T> = {
      success: false,
      data: null,
      rawOutput: '',
      tokensUsed: 0,
      latencyMs: 0,
      error: 'SLM not available',
    };
    return { response: empty, health: record };
  }

  let response: SLMResponse<T>;
  try {
    response = await runSLM<T>(stage, context, options.overrides);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    response = {
      success: false,
      data: null,
      rawOutput: '',
      tokensUsed: 0,
      latencyMs: 0,
      error: `threw: ${errMsg}`,
    };
  }

  const validation = (options.validate || defaultValidate)(response);

  let status: SLMHealthStatus;
  let fallbackUsed: boolean;
  if (!response.success) {
    status = 'fail';
    fallbackUsed = true;
  } else if (!validation.ok) {
    status = 'degraded';
    fallbackUsed = true;
  } else {
    status = 'pass';
    fallbackUsed = false;
    if (ctx.slmStagesRun && !ctx.slmStagesRun.includes(stage)) {
      ctx.slmStagesRun.push(stage);
    }
  }

  const record: SLMHealthRecord = {
    stage,
    status,
    summary: validation.summary,
    applied: validation.applied,
    attempted: validation.attempted,
    latencyMs: response.latencyMs,
    tokensUsed: response.tokensUsed,
    reasons: validation.reasons || (response.error ? [response.error] : []),
    fallbackUsed,
    timestamp: Date.now(),
  };
  records.push(record);
  emitHealthStep(ctx, stage, record);
  // Initiative C — fan record out to env-gated observability sinks.
  // Lazy-required to avoid a circular dependency at module init.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { emitSLMHealth } = await import('./telemetry/sinks.js');
    emitSLMHealth(record);
  } catch {
    /* sink emission is best-effort */
  }

  return { response, health: record };
}

/**
 * Build a one-line summary of all SLM health for end-of-pipeline display.
 * Returns null if no SLM was attempted.
 */
export function summarizeSLMHealth(ctx: SLMHealthContextSlice): {
  total: number;
  pass: number;
  degraded: number;
  fail: number;
  skipped: number;
  friendly: string;
  technical: string;
} | null {
  const records = ctx.slmHealth || [];
  if (records.length === 0) return null;

  let pass = 0, degraded = 0, fail = 0, skipped = 0;
  for (const r of records) {
    if (r.status === 'pass') pass++;
    else if (r.status === 'degraded') degraded++;
    else if (r.status === 'fail') fail++;
    else if (r.status === 'skipped') skipped++;
  }
  const total = records.length;

  const parts: string[] = [];
  if (pass > 0) parts.push(`${pass} healthy`);
  if (degraded > 0) parts.push(`${degraded} degraded`);
  if (fail > 0) parts.push(`${fail} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  const friendly = `AI quality check: ${parts.join(', ')} of ${total} stages`;

  const stageList = records.map(r => `${r.stage}=${r.status}`).join(' ');
  const technical = `slm-health total=${total} ${stageList}`;

  return { total, pass, degraded, fail, skipped, friendly, technical };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Pre-built validators for the 8 known SLM stages. Call sites pick the one
 * that matches the stage and pass it as `options.validate`. Each validator
 * inspects the SLM output against the known contract for that stage.
 * ───────────────────────────────────────────────────────────────────────── */

export const validators = {
  understanding(response: SLMResponse<any>): SLMValidation {
    if (!response.success || !response.data) {
      return { ok: false, summary: 'no enhancements returned', reasons: [response.error || 'empty'] };
    }
    const implicit = response.data.implicitRequirements?.length || 0;
    const inferred = (response.data.entities || []).filter((e: any) => e.isImplied).length;
    if (implicit === 0 && inferred === 0) {
      return { ok: false, summary: 'no useful enhancements found', applied: 0, attempted: 0 };
    }
    return {
      ok: true,
      summary: `added ${implicit} implicit requirement${implicit === 1 ? '' : 's'}, ${inferred} inferred entit${inferred === 1 ? 'y' : 'ies'}`,
      applied: implicit + inferred,
      attempted: implicit + inferred,
    };
  },

  semantic(response: SLMResponse<any>): SLMValidation {
    if (!response.success || !response.data) {
      return { ok: false, summary: 'no semantic deepening returned', reasons: [response.error || 'empty'] };
    }
    const rels = response.data.relationships?.length || 0;
    const rules = response.data.businessRules?.length || 0;
    const total = rels + rules;
    if (total === 0) return { ok: false, summary: 'no new relationships or rules', applied: 0, attempted: 0 };
    return {
      ok: true,
      summary: `enriched ${rels} relationship${rels === 1 ? '' : 's'} and ${rules} business rule${rules === 1 ? '' : 's'}`,
      applied: total,
      attempted: total,
    };
  },

  design(response: SLMResponse<any>): SLMValidation {
    if (!response.success || !response.data) {
      return { ok: false, summary: 'no design refinements returned', reasons: [response.error || 'empty'] };
    }
    const data = response.data;
    const refined = (data.colorRationale ? 1 : 0) + (data.typographyRationale ? 1 : 0) + (data.tokens?.length || 0);
    if (refined === 0) return { ok: false, summary: 'no useful refinements', applied: 0, attempted: 0 };
    return { ok: true, summary: `refined ${refined} design token${refined === 1 ? '' : 's'}/rationale`, applied: refined, attempted: refined };
  },

  schemaPatches(response: SLMResponse<any>, isPatchValid: (p: any) => boolean): SLMValidation {
    if (!response.success || !response.data) {
      return { ok: false, summary: 'no schema patches returned', reasons: [response.error || 'empty'] };
    }
    const patches: any[] = Array.isArray(response.data.patches) ? response.data.patches : [];
    const attempted = patches.length;
    const applied = patches.filter(isPatchValid).length;
    if (attempted === 0) return { ok: false, summary: 'AI proposed no patches', applied: 0, attempted: 0 };
    if (applied === 0) {
      return { ok: false, summary: `${attempted} patch${attempted === 1 ? '' : 'es'} proposed but none valid`, applied: 0, attempted, reasons: ['all patches failed validation'] };
    }
    return {
      ok: true,
      summary: `applied ${applied} of ${attempted} schema patch${attempted === 1 ? '' : 'es'}`,
      applied,
      attempted,
    };
  },

  apiPatches(response: SLMResponse<any>, isPatchValid: (p: any) => boolean): SLMValidation {
    if (!response.success || !response.data) {
      return { ok: false, summary: 'no API patches returned', reasons: [response.error || 'empty'] };
    }
    const patches: any[] = Array.isArray(response.data.patches) ? response.data.patches : [];
    const attempted = patches.length || (response.data ? 1 : 0);
    const applied = patches.length > 0
      ? patches.filter(isPatchValid).length
      : (isPatchValid(response.data) ? 1 : 0);
    if (attempted === 0) return { ok: false, summary: 'AI proposed no API improvements', applied: 0, attempted: 0 };
    if (applied === 0) {
      return { ok: false, summary: `${attempted} API patch${attempted === 1 ? '' : 'es'} proposed but none valid`, applied: 0, attempted };
    }
    return {
      ok: true,
      summary: `applied ${applied} of ${attempted} API patch${attempted === 1 ? '' : 'es'}`,
      applied,
      attempted,
    };
  },

  componentPatches(response: SLMResponse<any>, isPatchValid: (p: any) => boolean): SLMValidation {
    if (!response.success || !response.data) {
      return { ok: false, summary: 'no component refinements returned', reasons: [response.error || 'empty'] };
    }
    const patches: any[] = Array.isArray(response.data.patches) ? response.data.patches : [];
    const attempted = patches.length || (response.data ? 1 : 0);
    const applied = patches.length > 0
      ? patches.filter(isPatchValid).length
      : (isPatchValid(response.data) ? 1 : 0);
    if (attempted === 0) return { ok: false, summary: 'AI proposed no component changes', applied: 0, attempted: 0 };
    if (applied === 0) {
      return { ok: false, summary: `${attempted} component patch${attempted === 1 ? '' : 'es'} proposed but none valid`, applied: 0, attempted };
    }
    return {
      ok: true,
      summary: `applied ${applied} of ${attempted} component refinement${attempted === 1 ? '' : 's'}`,
      applied,
      attempted,
    };
  },

  codegenEnhancements(
    response: SLMResponse<any>,
    isEnhancementValid: (e: any) => boolean,
  ): SLMValidation {
    if (!response.success || !response.data) {
      return { ok: false, summary: 'no code enhancements returned', reasons: [response.error || 'empty'] };
    }
    const enhancements: any[] = Array.isArray(response.data.enhancements) ? response.data.enhancements : [];
    const attempted = enhancements.length;
    const applied = enhancements.filter(isEnhancementValid).length;
    if (attempted === 0) return { ok: false, summary: 'AI suggested no improvements', applied: 0, attempted: 0 };
    if (applied === 0) {
      return { ok: false, summary: `${attempted} suggestion${attempted === 1 ? '' : 's'} but none safely applicable`, applied: 0, attempted };
    }
    return {
      ok: true,
      summary: `improved ${applied} function${applied === 1 ? '' : 's'} (${attempted} suggested)`,
      applied,
      attempted,
    };
  },

  qualityIssues(response: SLMResponse<any>): SLMValidation {
    if (!response.success || !response.data) {
      return { ok: false, summary: 'no quality issues identified', reasons: [response.error || 'empty'] };
    }
    const issues = Array.isArray(response.data.issues) ? response.data.issues.length : 0;
    if (issues === 0) {
      return { ok: true, summary: 'no quality issues found — code is clean', applied: 0, attempted: 0 };
    }
    return { ok: true, summary: `flagged ${issues} quality issue${issues === 1 ? '' : 's'} for review`, applied: issues, attempted: issues };
  },
};

/** In-memory cross-conversation rolling history for /api/slm/health. */
const recentHealth: SLMHealthRecord[] = [];
const RECENT_LIMIT = 200;

export function publishHealthRecords(records: SLMHealthRecord[]): void {
  for (const r of records) {
    recentHealth.push(r);
    if (recentHealth.length > RECENT_LIMIT) recentHealth.shift();
  }
}

export function getRecentHealth(limit = 50): SLMHealthRecord[] {
  return recentHealth.slice(-limit).reverse();
}
