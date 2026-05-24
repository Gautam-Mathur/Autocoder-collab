/**
 * PLANNER — Feature owner (Fusion mode).
 * Adapts AutoCoder's already-generated ProjectPlan (passed in via legacyCtx)
 * into RuFlo's PlannerOutput. Synthesises features from plan.pages /
 * plan.dataModel when present, otherwise falls back to the TaskSpec shape.
 *
 * Reads:  legacyCtx.plan, mem.taskSpec
 * Writes: PlannerOutput { features[], requirements[], todo[] }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import type { AgentRunContext } from '../agent-runner.js';
import type { Feature, PlannerOutput, Requirement, TaskSpec, TodoItem } from '../types.js';

export async function runPlanner(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<PlannerOutput> {
  const spec = ledger.read('Planner', 'taskSpec') as TaskSpec | null;
  if (!spec) throw new Error('Planner: no taskSpec in memory');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plan = runCtx.legacyCtx?.plan as any | undefined;
  const features: Feature[] = [];
  let i = 0;

  // Prefer pages from the real plan (each page is a user-facing feature).
  if (plan?.pages && Array.isArray(plan.pages)) {
    for (const page of plan.pages) {
      const name = String(page.name ?? page.path ?? `Page${i + 1}`);
      features.push({
        id: `F${String(++i).padStart(3, '0')}`,
        name: titleCase(name),
        acceptanceCriteria: page.description ? [String(page.description)] : defaultCriteria(name),
        priority: 'must',
      });
    }
  }
  // Add data-model entities as CRUD features.
  if (plan?.dataModel && Array.isArray(plan.dataModel)) {
    for (const entity of plan.dataModel) {
      const name = String(entity.name ?? `Entity${i + 1}`);
      const label = `Manage ${name}`;
      if (!features.some((f) => f.name.toLowerCase() === label.toLowerCase())) {
        features.push({
          id: `F${String(++i).padStart(3, '0')}`,
          name: label,
          acceptanceCriteria: [`Create ${name}`, `List ${name}`, `Update ${name}`, `Delete ${name}`],
          priority: 'must',
        });
      }
    }
  }
  // Fallback: project from TaskSpec.
  if (features.length === 0) {
    for (const f of spec.mustHaveFeatures) {
      features.push({
        id: `F${String(++i).padStart(3, '0')}`,
        name: titleCase(f),
        acceptanceCriteria: defaultCriteria(f),
        priority: 'must',
      });
    }
  }
  // Always ensure foundational features exist.
  for (const r of ['Main View', 'List Items', 'Create Item']) {
    if (!features.some((f) => f.name.toLowerCase() === r.toLowerCase())) {
      features.push({
        id: `F${String(++i).padStart(3, '0')}`,
        name: r,
        acceptanceCriteria: defaultCriteria(r),
        priority: 'must',
      });
    }
  }

  const requirements: Requirement[] = [
    { id: 'R001', description: `Domain: ${spec.domain}`, type: 'non-functional' },
    { id: 'R002', description: `Primary user: ${spec.userType}`, type: 'non-functional' },
    { id: 'R003', description: `Core flow: ${spec.coreFlow}`, type: 'functional' },
    ...spec.explicitNonGoals.map<Requirement>((g, j) => ({
      id: `R${String(100 + j)}`, description: `Out of scope: ${g}`, type: 'non-functional',
    })),
  ];
  const todo: TodoItem[] = features.map((f, idx) => ({
    id: `T${String(idx + 1).padStart(3, '0')}`,
    description: `Implement ${f.name}`,
    done: false,
  }));

  return { features, requirements, todo };
}

function titleCase(s: string): string {
  return s.replace(/(^|[\s\-_/])(\w)/g, (_, sp: string, c: string) => sp + c.toUpperCase()).replace(/[\-_/]/g, ' ').trim();
}
function defaultCriteria(name: string): string[] {
  const n = name.toLowerCase();
  if (n.includes('list')) return ['Renders items from data source', 'Handles empty state', 'Sorts in stable order'];
  if (n.includes('create') || n.includes('form')) return ['Form validates input', 'Persists on submit', 'Shows confirmation'];
  if (n.includes('auth')) return ['Login form works', 'Session persists', 'Logout clears session'];
  if (n.includes('dashboard')) return ['Aggregates key metrics', 'Updates without full reload'];
  return [`User can interact with ${name}`, 'Feature is reachable from a primary navigation point'];
}
