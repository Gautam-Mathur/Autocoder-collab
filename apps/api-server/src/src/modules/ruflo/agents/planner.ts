/**
 * PLANNER — Feature owner
 * Planning features, requirements, and todo lists.
 *
 * Reads:  mem.taskSpec
 * Writes: PlannerOutput { features[], requirements[], todo[] }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import { runSLM, registerStageTemplate } from '../../slm-inference-engine.js';
import type { AgentRunContext } from '../agent-runner.js';
import type { Feature, PlannerOutput, Requirement, TaskSpec, TodoItem } from '../types.js';

registerStageTemplate({
  stage: 'Planner',
  systemPrompt: `You are the Planner agent in a multi-agent system.
Your job is to read the Queen's task specification and create a detailed planning output.
Specifically, you must generate:
1. features: a list of features required for the application. Each feature has:
   - id: e.g. "F001"
   - name: title-case name of the feature
   - acceptanceCriteria: list of strings defining completion conditions
   - priority: "must" | "should" | "could"
2. requirements: functional and non-functional requirements. Each has:
   - id: e.g. "R001"
   - description: description of the requirement
   - type: "functional" | "non-functional"
3. todo: checklist of todo items to build the features. Each has:
   - id: e.g. "T001"
   - description: what needs to be done
   - done: boolean (should be false)

Focus your planning on this instruction: "{agentTask}"`,
  userPromptBuilder: (context: Record<string, any>) => `Queen's Task Specification:\n${JSON.stringify(context.taskSpec, null, 2)}`,
  outputSchema: {
    type: 'object',
    properties: {
      features: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            acceptanceCriteria: { type: 'array', items: { type: 'string' } },
            priority: { type: 'string', enum: ['must', 'should', 'could'] }
          },
          required: ['id', 'name', 'acceptanceCriteria', 'priority']
        }
      },
      requirements: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: 'string' },
            type: { type: 'string', enum: ['functional', 'non-functional'] }
          },
          required: ['id', 'description', 'type']
        }
      },
      todo: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: 'string' },
            done: { type: 'boolean' }
          },
          required: ['id', 'description', 'done']
        }
      }
    },
    required: ['features', 'requirements', 'todo']
  },
  maxTokens: 1536,
  temperature: 0.3
});

export async function runPlanner(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<PlannerOutput> {
  const spec = ledger.read('Planner', 'taskSpec') as TaskSpec | null;
  if (!spec) throw new Error('Planner: no taskSpec in memory');

  const agentTask = spec.agentTasks?.Planner || `Create a detailed feature plan for the ${spec.domain} application.`;

  const slmResult = await runSLM<PlannerOutput>('Planner', { taskSpec: spec, agentTask });
  if (slmResult.success && slmResult.data) {
    return slmResult.data;
  }

  // Standalone rule-based fallback.
  const features: Feature[] = [];
  let i = 0;

  for (const f of spec.mustHaveFeatures) {
    features.push({
      id: `F${String(++i).padStart(3, '0')}`,
      name: titleCase(f),
      acceptanceCriteria: defaultCriteria(f),
      priority: 'must',
    });
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
