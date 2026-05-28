import { logger } from '../logger.js';
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

  const msg = formatEventMessage(event);
  if (event.type.includes('fail') || event.type.includes('halt') || event.type.includes('violation')) {
    logger.warn('Pipeline', msg, { event });
  } else if (event.type.includes('complete') || event.type.includes('pass')) {
    logger.success('Pipeline', msg, { event });
  } else {
    logger.info('Pipeline', msg, { event });
  }
}

function formatEventMessage(event: ObservabilityEvent): string {
  switch (event.type) {
    case 'agent_start':
      return `Agent "${event.agent}" starting`;
    case 'agent_complete':
      return `Agent "${event.agent}" completed in ${event.durationMs}ms`;
    case 'agent_skipped':
      return `Agent "${event.agent}" skipped: ${event.reason}`;
    case 'drift_event':
      return `Drift: agent "${event.agent}" updated field "${event.field}"`;
    case 'contract_violation':
      return `Contract violation [${event.contract}]: missing "${event.missing}" (responsible: ${event.responsible})`;
    case 'contract_pass':
      return `Contract passed for ${event.agent} (${event.contractsChecked} checked)`;
    case 'invalidation_propagated':
      return `Invalidation propagated from "${event.source}" to: ${event.affected.join(', ')}`;
    case 'patch_oversized':
      return `Patch oversized for "${event.agent}" on "${event.file}": ${event.size}B (limit: ${event.limit}B)`;
    case 'slm_unavailable':
      return `SLM unavailable for "${event.agent}", falling back to ${event.fallback}`;
    case 'halt_event':
      return `Halt: "${event.agent}" execution stopped - ${event.reason}`;
    case 'skip_event':
      return `Skip: "${event.agent}" bypassed - ${event.reason}`;
    case 'kb_injected':
      return `Knowledge injected for "${event.agent}" (${event.tokenCount} tokens)`;
    case 'kb_blocked':
      return `Knowledge block for "${event.agent}": ${event.reason}`;
    case 'ship_gate_pass':
      return `Ship Gate passed: verified ${event.filesChecked} files, applied ${event.repairsApplied} repairs`;
    case 'ship_gate_fallback':
      return `Ship Gate fallback triggered for "${event.file}" (Layer ${event.layer})`;
    default:
      return JSON.stringify(event);
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
