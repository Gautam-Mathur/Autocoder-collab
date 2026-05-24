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

export function validateConsistency(mem: ExecutiveMemory): ContractResult {
  const violations: ContractViolation[] = [];

  // CONTRACT 1 — Planner → Architect: every feature must have a module
  if (mem.planner && mem.architect) {
    const featureNames = mem.planner.features.map((f) => f.name);
    const moduleNames = mem.architect.architecture.modules.map((m) => m.name);
    for (const feature of featureNames) {
      const has = moduleNames.some((m) => namesMatch(m, feature));
      if (!has) {
        violations.push({
          contract: 'planner→architect',
          missing: feature,
          responsibleAgent: 'Architect',
          description: `Feature "${feature}" has no corresponding module in architecture.modules[]`,
        });
      }
    }
  }

  // CONTRACT 2 — System → Designer: every data model must have a UI consumer
  if (mem.system && mem.designer) {
    const models = mem.system.logic.dataModels.map((m) => m.name);
    const consumers = mem.designer.components
      .map((c) => c.consumes)
      .filter((x): x is string => Boolean(x));
    for (const model of models) {
      if (!consumers.some((c) => namesMatch(c, model))) {
        violations.push({
          contract: 'system→designer',
          missing: model,
          responsibleAgent: 'Designer',
          description: `Data model "${model}" has no UI component that declares it in .consumes`,
        });
      }
    }
  }

  for (const v of violations) {
    logEvent({
      type: 'contract_violation',
      contract: v.contract,
      missing: v.missing,
      responsible: v.responsibleAgent,
    });
  }

  return { ok: violations.length === 0, violations };
}

export function findResponsibleAgents(violations: ContractViolation[]): AgentName[] {
  return [...new Set(violations.map((v) => v.responsibleAgent))];
}

function namesMatch(a: string, b: string): boolean {
  return canonical(a) === canonical(b) || canonical(a).includes(canonical(b)) || canonical(b).includes(canonical(a));
}

function canonical(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
