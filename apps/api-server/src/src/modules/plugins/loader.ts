/**
 * Plugin loader — discovers plugins under `<repo>/plugins/*.ts|*.js` (when
 * the runtime supports dynamic import of source files; in production builds
 * only `.js` is loaded), plus an in-process registry for built-in plugins.
 *
 * Plugins are loaded lazily on first call. A plugin that fails to load is
 * recorded in the audit and is NOT retried — a broken plugin must not
 * keep crashing the pipeline.
 */

import type {
  PipelinePlugin,
  PluginAuditEntry,
  PluginContext,
  PluginRunResult,
  PluginStageHook,
} from './types.js';
import { emit as emitTelemetry } from '../telemetry/sinks.js';

const registry: PipelinePlugin[] = [];
const failedPlugins = new Set<string>();

export function registerPlugin(plugin: PipelinePlugin): void {
  if (!plugin || !plugin.id || !plugin.hook || typeof plugin.run !== 'function') {
    // eslint-disable-next-line no-console
    console.warn('[plugins] rejected malformed plugin:', plugin && plugin.id);
    return;
  }
  if (registry.find((p) => p.id === plugin.id)) {
    // eslint-disable-next-line no-console
    console.warn(`[plugins] duplicate plugin id ignored: ${plugin.id}`);
    return;
  }
  registry.push(plugin);
}

export function listPlugins(): PipelinePlugin[] {
  return [...registry].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
}

export function getPluginsForHook(hook: PluginStageHook): PipelinePlugin[] {
  return listPlugins().filter((p) => p.hook === hook && !failedPlugins.has(p.id));
}

/**
 * Run all plugins registered for `hook` against `ctx`. Returns the audit
 * entries AND collected `PluginRunResult`s so the orchestrator can route
 * any `patch`es through `applyEnhancementPatches`.
 *
 * NEVER throws — every plugin error is captured.
 */
export async function runPluginsForHook(
  hook: PluginStageHook,
  ctx: PluginContext,
): Promise<{ audit: PluginAuditEntry[]; results: Array<{ pluginId: string; result: PluginRunResult }> }> {
  const audit: PluginAuditEntry[] = [];
  const results: Array<{ pluginId: string; result: PluginRunResult }> = [];

  // Per-plugin wall-clock cap. A plugin that does `while(true){}` or hangs
  // on a network call MUST NOT stall the pipeline. Override via env.
  const PLUGIN_TIMEOUT_MS = Number(process.env.AUTOCODER_PLUGIN_TIMEOUT_MS) || 5000;

  for (const plugin of getPluginsForHook(hook)) {
    const start = Date.now();
    try {
      const r = await Promise.race([
        Promise.resolve(plugin.run(ctx)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`plugin timed out after ${PLUGIN_TIMEOUT_MS}ms`)), PLUGIN_TIMEOUT_MS)
        ),
      ]);
      const durationMs = Date.now() - start;
      audit.push({ pluginId: plugin.id, hook, status: 'ran', durationMs, notes: r.notes });
      results.push({ pluginId: plugin.id, result: r });
      emitTelemetry({
        kind: 'plugin.run',
        timestamp: Date.now(),
        conversationId: ctx.conversationId,
        payload: {
          pluginId: plugin.id,
          hook,
          durationMs,
          producedPatch: !!r.patch,
          notes: r.notes,
        },
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      audit.push({ pluginId: plugin.id, hook, status: 'error', durationMs, error: errMsg });
      failedPlugins.add(plugin.id);
      // eslint-disable-next-line no-console
      console.warn(`[plugins] plugin "${plugin.id}" threw at hook "${hook}" — disabled for the rest of the run:`, errMsg);
      emitTelemetry({
        kind: 'plugin.error',
        timestamp: Date.now(),
        conversationId: ctx.conversationId,
        payload: { pluginId: plugin.id, hook, error: errMsg, durationMs },
      });
    }
  }

  return { audit, results };
}

/**
 * Best-effort dynamic discovery of plugin files under `<repo>/plugins`.
 * Idempotent — calling it more than once is a no-op after the first call.
 *
 * NEVER throws on a missing or empty `plugins/` directory — third-party
 * plugins are 100% optional.
 */
let discovered = false;
export async function discoverFsPlugins(rootDir: string): Promise<void> {
  if (discovered) return;
  discovered = true;
  // Security: filesystem plugin loading executes arbitrary JS at startup.
  // Disabled unless the operator explicitly opts in via env. Programmatic
  // `registerPlugin()` callers (incl. the built-in example) are unaffected.
  if (process.env.AUTOCODER_PLUGINS_ENABLED !== '1') return;
  try {
    const fs = await import('fs');
    const path = await import('path');
    const pluginsDir = path.resolve(rootDir, 'plugins');
    if (!fs.existsSync(pluginsDir)) return;
    const entries = fs.readdirSync(pluginsDir);
    for (const entry of entries) {
      if (!/\.(m?js|cjs)$/i.test(entry)) continue;
      const full = path.join(pluginsDir, entry);
      try {
        const mod = await import(full);
        const candidate = mod.default || mod.plugin;
        if (candidate) registerPlugin(candidate);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[plugins] failed to load ${entry}:`, err instanceof Error ? err.message : err);
      }
    }
  } catch {
    // Plugin discovery is best-effort.
  }
}

/** Reset for tests. */
export function _resetPluginsForTests(): void {
  registry.length = 0;
  failedPlugins.clear();
  discovered = false;
}
