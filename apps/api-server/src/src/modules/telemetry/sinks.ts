/**
 * Initiative C — Observability Sinks
 *
 * Pluggable, env-gated sinks that receive every SLMHealthRecord (and other
 * telemetry events) emitted by the pipeline. Sink failures are isolated:
 * a sink that throws is logged and removed from rotation for the rest of
 * the process; the SLM call itself NEVER observes a sink failure.
 *
 * Built-in sinks:
 *   - console            (always on; off when OBS_CONSOLE=0)
 *   - langsmith          (gated on LANGSMITH_API_KEY)
 *   - langfuse           (gated on LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY)
 *   - otel               (gated on OTEL_EXPORTER_OTLP_ENDPOINT, JSON over HTTP)
 *
 * All sinks share the same `TelemetryEvent` shape so the same wire-up handles
 * SLM health, plugin lifecycle, dry-run snapshots, and graph-verify outcomes.
 */

import type { SLMHealthRecord } from '../slm-health-monitor.js';

export type TelemetryEventKind =
  | 'slm.health'
  | 'plugin.run'
  | 'plugin.error'
  | 'dryrun.snapshot'
  | 'pipeline.summary'
  | 'mcp.tool.call'
  | 'drift.event'
  | 'agent.decision';

export interface TelemetryEvent {
  kind: TelemetryEventKind;
  timestamp: number;
  /** Optional conversation id for tracing. */
  conversationId?: number | string;
  /** Free-form payload — sinks decide how to render it. */
  payload: Record<string, unknown>;
}

export interface TelemetrySink {
  name: string;
  enabled: boolean;
  emit: (event: TelemetryEvent) => void | Promise<void>;
}

const sinks: TelemetrySink[] = [];
const failedSinks = new Set<string>();

function envBool(name: string, defaultVal = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultVal;
  return !/^(0|false|no|off)$/i.test(v);
}

function buildConsoleSink(): TelemetrySink {
  return {
    name: 'console',
    enabled: envBool('OBS_CONSOLE', true),
    emit(event) {
      // Compact one-line JSON for log-grep friendliness.
      const out = { kind: event.kind, ts: event.timestamp, ...event.payload };
      // eslint-disable-next-line no-console
      console.log(`[telemetry] ${JSON.stringify(out)}`);
    },
  };
}

function buildLangSmithSink(): TelemetrySink | null {
  const apiKey = process.env.LANGSMITH_API_KEY;
  if (!apiKey) return null;
  const endpoint = process.env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com';
  const project = process.env.LANGSMITH_PROJECT || 'autocoder';
  return {
    name: 'langsmith',
    enabled: true,
    async emit(event) {
      const body = {
        name: event.kind,
        run_type: 'tool',
        inputs: { conversationId: event.conversationId },
        outputs: event.payload,
        start_time: new Date(event.timestamp).toISOString(),
        end_time: new Date().toISOString(),
        project_name: project,
      };
      await fetch(`${endpoint}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(body),
      });
    },
  };
}

function buildLangFuseSink(): TelemetrySink | null {
  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_SECRET_KEY;
  if (!pub || !sec) return null;
  const baseUrl = process.env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com';
  const auth = Buffer.from(`${pub}:${sec}`).toString('base64');
  return {
    name: 'langfuse',
    enabled: true,
    async emit(event) {
      const body = {
        batch: [{
          id: `${event.kind}-${event.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'event-create',
          timestamp: new Date(event.timestamp).toISOString(),
          body: {
            name: event.kind,
            traceId: String(event.conversationId || 'global'),
            input: { conversationId: event.conversationId },
            output: event.payload,
          },
        }],
      };
      await fetch(`${baseUrl}/api/public/ingestion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
        body: JSON.stringify(body),
      });
    },
  };
}

function buildOTelSink(): TelemetrySink | null {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return null;
  const serviceName = process.env.OTEL_SERVICE_NAME || 'autocoder-api-server';
  return {
    name: 'otel',
    enabled: true,
    async emit(event) {
      // Minimal OTLP/HTTP JSON log envelope — avoids the otel SDK dep.
      const nano = String(event.timestamp) + '000000';
      const body = {
        resourceLogs: [{
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
          },
          scopeLogs: [{
            scope: { name: 'autocoder.telemetry' },
            logRecords: [{
              timeUnixNano: nano,
              severityText: 'INFO',
              body: { stringValue: event.kind },
              attributes: Object.entries(event.payload).slice(0, 32).map(([k, v]) => ({
                key: k,
                value: { stringValue: typeof v === 'string' ? v : JSON.stringify(v).slice(0, 1024) },
              })),
            }],
          }],
        }],
      };
      await fetch(`${endpoint.replace(/\/$/, '')}/v1/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },
  };
}

let initialised = false;
function initSinks(): void {
  if (initialised) return;
  initialised = true;
  const candidates = [
    buildConsoleSink(),
    buildLangSmithSink(),
    buildLangFuseSink(),
    buildOTelSink(),
  ];
  for (const s of candidates) {
    if (s && s.enabled) sinks.push(s);
  }
}

/**
 * Push a telemetry event to all enabled sinks. Sink errors are caught and
 * tracked; a sink that fails twice is removed from rotation to avoid
 * cascading log noise. NEVER throws.
 */
export function emit(event: TelemetryEvent): void {
  initSinks();
  for (const sink of sinks) {
    if (failedSinks.has(sink.name)) continue;
    try {
      const r = sink.emit(event);
      if (r && typeof (r as Promise<void>).then === 'function') {
        (r as Promise<void>).catch((err) => recordSinkFailure(sink.name, err));
      }
    } catch (err) {
      recordSinkFailure(sink.name, err);
    }
  }
}

const failureCounts = new Map<string, number>();
function recordSinkFailure(name: string, err: unknown): void {
  const next = (failureCounts.get(name) || 0) + 1;
  failureCounts.set(name, next);
  // eslint-disable-next-line no-console
  console.warn(`[telemetry] sink "${name}" failed (${next}):`, err instanceof Error ? err.message : err);
  if (next >= 2) {
    failedSinks.add(name);
    // eslint-disable-next-line no-console
    console.warn(`[telemetry] sink "${name}" disabled after repeated failures`);
  }
}

export function getRegisteredSinks(): { name: string; enabled: boolean; failed: boolean }[] {
  initSinks();
  return sinks.map((s) => ({ name: s.name, enabled: s.enabled, failed: failedSinks.has(s.name) }));
}

/** Convenience helper for the SLM health hook. */
export function emitSLMHealth(record: SLMHealthRecord, conversationId?: number | string): void {
  emit({
    kind: 'slm.health',
    timestamp: record.timestamp,
    conversationId,
    payload: {
      stage: record.stage,
      status: record.status,
      summary: record.summary,
      latencyMs: record.latencyMs,
      tokensUsed: record.tokensUsed,
      applied: record.applied,
      attempted: record.attempted,
      fallbackUsed: record.fallbackUsed,
      reasons: record.reasons,
    },
  });
}

export function emitDriftEvent(agent: string, field: string, value: unknown, rationale?: string, conversationId?: number | string): void {
  emit({
    kind: 'drift.event',
    timestamp: Date.now(),
    conversationId,
    payload: {
      agent,
      field,
      value,
      rationale,
    },
  });
}

export function emitDecision(agent: string, field: string, value: unknown, rationale?: string, conversationId?: number | string): void {
  emit({
    kind: 'agent.decision',
    timestamp: Date.now(),
    conversationId,
    payload: {
      agent,
      field,
      value,
      rationale,
    },
  });
}

/** Reset for tests. */
export function _resetSinksForTests(): void {
  sinks.length = 0;
  failedSinks.clear();
  failureCounts.clear();
  initialised = false;
}
