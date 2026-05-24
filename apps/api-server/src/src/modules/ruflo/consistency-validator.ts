import { ExecutiveMemory } from './executive-memory.js';
import { logEvent } from './observability-sink.js';
import type { ContractResult, ContractViolation } from './types.js';

export function validateConsistency(mem: ExecutiveMemory): ContractResult {
  const violations: ContractViolation[] = [];

  // CONTRACT 1 — Planner → Architect: every planned feature must have a module
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

  // CONTRACT 2 — System → Designer: UI data models must align with system data models
  if (mem.system && mem.designer) {
    const models = mem.system.logic.dataModels.map((m) => m.name);
    
    // Check A: every system data model must have a UI consumer component
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

    // Check B: every UI component's .consumes must have a system data model or API consumer
    for (const comp of mem.designer.components) {
      if (comp.consumes) {
        const matchesModel = models.some((m) => namesMatch(comp.consumes!, m));
        const matchesRoute = mem.system.apiRoutes.some((r) => namesMatch(comp.consumes!, r.path) || namesMatch(comp.consumes!, r.handler));
        if (!matchesModel && !matchesRoute) {
          violations.push({
            contract: 'system→designer',
            missing: comp.consumes,
            responsibleAgent: 'Designer',
            description: `UI Component "${comp.name}" consumes "${comp.consumes}" but no matching System data model or API route exists.`,
          });
        }
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

function namesMatch(a: string, b: string): boolean {
  return canonical(a) === canonical(b) || canonical(a).includes(canonical(b)) || canonical(b).includes(canonical(a));
}

function canonical(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
