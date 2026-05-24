/**
 * RuFlo Fusion — Contract validator
 *
 * The hard gate that runs after Architect and after Designer. If either
 * contract fails, the pipeline halts before the Coder runs. The responsible
 * agent is added to mem.invalidated so the controller will re-run only it.
 */

import { ExecutiveMemory } from './executive-memory.js';
import { logEvent } from './observability-sink.js';
import type { AgentName, ContractResult, ContractViolation } from './types.js';

export class ContractViolationError extends Error {
  override name = 'ContractViolationError';
  constructor(public violations: ContractViolation[]) {
    super(
      `ContractViolation: ${violations.length} violation(s):\n` +
        violations.map((v) => `  - [${v.contract}] ${v.description}`).join('\n'),
    );
  }
}

export { validateConsistency } from './consistency-validator.js';

export function findResponsibleAgents(violations: ContractViolation[]): AgentName[] {
  return [...new Set(violations.map((v) => v.responsibleAgent))];
}
