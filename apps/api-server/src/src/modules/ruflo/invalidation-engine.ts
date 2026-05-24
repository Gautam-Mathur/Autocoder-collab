import { ExecutiveMemory } from './executive-memory.js';
import { logEvent } from './observability-sink.js';
import type { AgentName } from './types.js';
import { DEPENDENCIES } from './dependency-graph.js';

export function propagateInvalidation(changed: AgentName, mem: ExecutiveMemory): void {
  const downstream = DEPENDENCIES[changed] ?? [];
  for (const a of downstream) {
    mem.invalidated.add(a);
  }

  logEvent({
    type: 'invalidation_propagated',
    source: changed,
    affected: [...downstream],
    total: mem.invalidated.size,
  });
}
