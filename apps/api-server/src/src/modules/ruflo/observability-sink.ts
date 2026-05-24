/**
 * RuFlo Fusion — Observability sink
 *
 * A per-pipeline-run event log. Events are also emitted to console in dev so
 * they appear in workflow logs alongside the existing pipeline output.
 */

import type { ObservabilityEvent } from './types.js';

const eventBuffer: ObservabilityEvent[] = [];

let externalEmitter: ((event: ObservabilityEvent) => void) | null = null;

export function logEvent(event: ObservabilityEvent): void {
  eventBuffer.push(event);
  if (externalEmitter) {
    try {
      externalEmitter(event);
    } catch {
      // never let an emitter failure break the pipeline
    }
  }
  if (process.env.RUFLO_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.log('[RuFlo]', JSON.stringify(event));
  }
}

/** Drain and return all buffered events (clears the buffer). */
export function drainEvents(): ObservabilityEvent[] {
  const out = [...eventBuffer];
  eventBuffer.length = 0;
  return out;
}

/** Snapshot the current buffer without clearing it. */
export function snapshotEvents(): ObservabilityEvent[] {
  return [...eventBuffer];
}

export function setExternalEmitter(fn: ((event: ObservabilityEvent) => void) | null): void {
  externalEmitter = fn;
}
