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
  Queen:     Object.freeze<AgentName[]>(['Planner', 'Architect', 'System', 'Designer', 'Coder', 'Debugger', 'Security', 'Reviewer', 'Tester']),
  Planner:   Object.freeze<AgentName[]>(['Architect', 'System', 'Designer', 'Coder', 'Debugger', 'Security', 'Reviewer', 'Tester']),
  Architect: Object.freeze<AgentName[]>(['System', 'Designer', 'Coder', 'Debugger', 'Security', 'Reviewer', 'Tester']),
  System:    Object.freeze<AgentName[]>(['Designer', 'Coder', 'Debugger', 'Security', 'Reviewer', 'Tester']),
  Designer:  Object.freeze<AgentName[]>(['Coder', 'Debugger', 'Security', 'Reviewer', 'Tester']),
  Coder:     Object.freeze<AgentName[]>(['Debugger', 'Security', 'Reviewer', 'Tester']),
  Debugger:  Object.freeze<AgentName[]>(['Security', 'Reviewer', 'Tester']),
  Security:  Object.freeze<AgentName[]>(['Reviewer']),
  Reviewer:  Object.freeze<AgentName[]>([]),
  Tester:    Object.freeze<AgentName[]>([]),
}) as Readonly<Record<AgentName, readonly AgentName[]>>;

export { propagateInvalidation } from './invalidation-engine.js';

/**
 * shouldRun gate.
 *
 * First run (empty invalidated set) → run everyone.
 * Subsequent runs → only run agents that are in the dirty set.
 * If only frontend components are invalidated, we skip stable backend stages.
 */
export function shouldRun(agent: AgentName, mem: ExecutiveMemory): boolean {
  if (mem.invalidated.size === 0) return true;

  const BACKEND_STAGES: AgentName[] = ['Queen', 'Planner', 'Architect', 'System'];
  const hasBackendInvalidated = [...mem.invalidated].some(a => BACKEND_STAGES.includes(a));

  if (BACKEND_STAGES.includes(agent)) {
    if (!hasBackendInvalidated) {
      return false; // Skip stable backend stages
    }
  }

  return mem.invalidated.has(agent);
}
