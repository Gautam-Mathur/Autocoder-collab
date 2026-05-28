/**
 * RuFlo Fusion — Dependency graph + surgical execution
 *
 * When agent X produces fresh output, every downstream agent's previous
 * output is no longer trusted. We mark them dirty in `mem.invalidated` so
 * shouldRun() runs them and skips agents that have not been invalidated.
 */

import { ExecutiveMemory } from './executive-memory.js';
import { logEvent } from './observability-sink.js';
import type { AgentName } from './types.js';

// Security runs after Coder/Debugger because it scans source files. It is
// included in every upstream agent's downstream list so any spec/code change
// re-triggers it on the bounded retry pass.
export const DEPENDENCIES: Readonly<Record<AgentName, readonly AgentName[]>> = Object.freeze({
  Queen:     Object.freeze<AgentName[]>(['Planner', 'Architect', 'System', 'Designer', 'Coder', 'Debugger', 'Security', 'Reviewer', 'Tester', 'Refiner']),
  Planner:   Object.freeze<AgentName[]>(['Architect', 'System', 'Designer', 'Coder', 'Debugger', 'Security', 'Reviewer', 'Tester', 'Refiner']),
  Architect: Object.freeze<AgentName[]>(['Coder', 'Debugger', 'Security', 'Reviewer', 'Tester', 'Refiner']),
  System:    Object.freeze<AgentName[]>(['Architect', 'Designer', 'Coder', 'Debugger', 'Security', 'Reviewer', 'Tester', 'Refiner']),
  Designer:  Object.freeze<AgentName[]>(['Coder', 'Debugger', 'Security', 'Reviewer', 'Tester', 'Refiner']),
  Coder:     Object.freeze<AgentName[]>(['Tester', 'Debugger', 'Security', 'Reviewer', 'Refiner']),
  Debugger:  Object.freeze<AgentName[]>(['Coder', 'Reviewer', 'Refiner']),
  Security:  Object.freeze<AgentName[]>(['Coder', 'Reviewer', 'Refiner']),
  Reviewer:  Object.freeze<AgentName[]>(['Coder']),
  Tester:    Object.freeze<AgentName[]>(['Debugger', 'Security', 'Reviewer']),
  Refiner:   Object.freeze<AgentName[]>(['Coder']),
}) as Readonly<Record<AgentName, readonly AgentName[]>>;

export function propagateInvalidation(changed: AgentName, mem: ExecutiveMemory): void {
  const downstream = DEPENDENCIES[changed] ?? [];
  for (const a of downstream) mem.invalidated.add(a);

  logEvent({
    type: 'invalidation_propagated',
    source: changed,
    affected: [...downstream],
    total: mem.invalidated.size,
  });
}

/**
 * shouldRun gate.
 *
 * First run (empty invalidated set) → run everyone.
 * Subsequent runs → only run agents that are in the dirty set.
 */
export function shouldRun(agent: AgentName, mem: ExecutiveMemory): boolean {
  if (mem.invalidated.size === 0) return true;
  return mem.invalidated.has(agent);
}
