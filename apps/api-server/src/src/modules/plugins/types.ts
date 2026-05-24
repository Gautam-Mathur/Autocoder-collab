/**
 * Initiative E — Pipeline Plugin API
 *
 * A pipeline plugin observes pipeline state at a specific stage boundary
 * and OPTIONALLY returns an `EnhancementPatch` that the orchestrator routes
 * through `applyEnhancementPatches` (Single-Writer compliant — see Fix 5).
 *
 * Plugins must be SAFE BY DEFAULT:
 *   - any throw is caught by the loader and recorded in `ctx.repairAudit`-
 *     style audit (kind=plugin, status=error)
 *   - patches that reference undeclared packages/providers are rejected by
 *     the existing `applyEnhancementPatches` validators — no special-casing
 *   - plugins NEVER mutate `ctx.files` directly (Single-Writer enforcement
 *     would throw via `assertNoDirectWrite` if they did)
 */

import type { EnhancementPatch } from '../enhancement-patch.js';

export type PluginStageHook =
  | 'after-understand'
  | 'after-plan'
  | 'after-architect'
  | 'after-schema'
  | 'after-api'
  | 'after-compose'
  | 'after-generate'
  | 'after-validate'
  | 'after-deep-quality'
  | 'pipeline-complete';

/**
 * Read-only slice of the orchestrator context exposed to plugins.
 * Intentionally narrow — plugins should NOT mutate the orchestrator
 * directly. Mutations happen via the returned `EnhancementPatch`.
 */
export interface PluginContext {
  userRequest: string;
  conversationId?: number | string;
  /** Snapshot at the time the hook fires. Read-only. */
  files: ReadonlyArray<{ path: string; content: string; language: string }>;
  /** Plan if available at this hook point. */
  plan?: unknown;
  /** Latest project graph (Task #18) if built. */
  projectGraph?: unknown;
  /** Latest semantic validation (Task #22) if run. */
  semanticValidation?: unknown;
}

export interface PluginRunResult {
  /** Optional patch — when omitted the plugin is observation-only. */
  patch?: EnhancementPatch;
  /** Free-form notes shown in audit. */
  notes?: string;
}

export interface PipelinePlugin {
  /** Stable id, unique per plugin. Used in audit + telemetry. */
  id: string;
  /** Human-friendly name for thinking steps. */
  name: string;
  /** Hook point — at most ONE per plugin (keep things predictable). */
  hook: PluginStageHook;
  /** Optional priority — lower runs first. Default 100. */
  priority?: number;
  /** Plugin entry point. MUST be pure-async; throws are caught by loader. */
  run: (ctx: PluginContext) => Promise<PluginRunResult> | PluginRunResult;
}

export interface PluginAuditEntry {
  pluginId: string;
  hook: PluginStageHook;
  status: 'ran' | 'error' | 'skipped';
  durationMs: number;
  notes?: string;
  error?: string;
}
