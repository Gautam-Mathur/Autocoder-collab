/**
 * SYSTEM — Backend logic owner
 * Designing data models, API routes, and database schemas.
 *
 * Reads:  mem.taskSpec, mem.planner
 * Writes: SystemOutput { logic, apiRoutes, schema }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import { runSLM, registerStageTemplate } from '../../slm-inference-engine.js';
import type { AgentRunContext } from '../agent-runner.js';
import type {
  ApiRoute,
  DataModel,
  PlannerOutput,
  SchemaSpec,
  SystemOutput,
  TaskSpec,
} from '../types.js';

registerStageTemplate({
  stage: 'System',
  systemPrompt: `You are the System agent in a multi-agent system.
Your job is to read the Queen's task specification and the Planner's output, then design the backend logical models, API routes, and database schema.
Specifically, you must generate a JSON object with:
1. logic:
   - dataModels: List of data models. Each has:
     - name: Name of the model
     - fields: Array of field descriptors containing name, type, and required flag
   - rules: Array of functional business rules. Each has:
     - name: ID or short name
     - description: details of the rule
2. apiRoutes: List of API endpoints. Each has:
   - method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
   - path: endpoint path (e.g. "/api/items", "/api/items/:id")
   - handler: name of handler function (e.g. "getItems")
   - consumes: name of consumed data model (optional)
   - produces: name of produced data model (optional)
3. schema:
   - tables: List of DB tables. Each has name and columns (name and type).

Focus on this instruction: "{agentTask}"`,
  userPromptBuilder: (context: Record<string, any>) => `Queen's Task Specification:\n${JSON.stringify(context.taskSpec, null, 2)}\n\nPlanner's Output:\n${JSON.stringify(context.planner, null, 2)}`,
  outputSchema: {
    type: 'object',
    properties: {
      logic: {
        type: 'object',
        properties: {
          dataModels: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                fields: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      type: { type: 'string' },
                      required: { type: 'boolean' }
                    },
                    required: ['name', 'type']
                  }
                }
              },
              required: ['name', 'fields']
            }
          },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' }
              },
              required: ['name', 'description']
            }
          }
        },
        required: ['dataModels', 'rules']
      },
      apiRoutes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
            path: { type: 'string' },
            handler: { type: 'string' },
            consumes: { type: 'string' },
            produces: { type: 'string' }
          },
          required: ['method', 'path', 'handler']
        }
      },
      schema: {
        type: 'object',
        properties: {
          tables: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                columns: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      type: { type: 'string' }
                    },
                    required: ['name', 'type']
                  }
                }
              },
              required: ['name', 'columns']
            }
          }
        },
        required: ['tables']
      }
    },
    required: ['logic', 'apiRoutes', 'schema']
  },
  maxTokens: 1536,
  temperature: 0.2
});

export async function runSystem(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<SystemOutput> {
  const planner = ledger.read('System', 'planner') as PlannerOutput | null;
  const spec = ledger.read('System', 'taskSpec') as TaskSpec | null;
  if (!planner || !spec) throw new Error('System: missing planner or taskSpec output');

  const agentTask = spec.agentTasks?.System || 'Define logical models and API endpoints.';

  const slmResult = await runSLM<SystemOutput>('System', { taskSpec: spec, planner, agentTask });
  if (slmResult.success && slmResult.data) {
    return slmResult.data;
  }

  // Standalone rule-based fallback.
  const dataModels: DataModel[] = [];
  const entities = new Set<string>();

  for (const f of planner.features) {
    const stripped = f.name.replace(/(Page|Panel|Dashboard|View|List|Form|Api|Manage)$/i, '');
    if (stripped.length > 1) entities.add(singularize(stripped));
  }
  if (entities.size === 0) entities.add('Item');
  for (const name of entities) {
    dataModels.push({ name, fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'createdAt', type: 'datetime', required: true },
      { name: 'name', type: 'string', required: true },
    ]});
  }

  const apiRoutes: ApiRoute[] = [];
  for (const m of dataModels) {
    const lower = m.name.toLowerCase();
    apiRoutes.push(
      { method: 'GET',    path: `/api/${lower}s`,     handler: `list${m.name}s`,  produces: m.name },
      { method: 'POST',   path: `/api/${lower}s`,     handler: `create${m.name}`, consumes: m.name, produces: m.name },
      { method: 'GET',    path: `/api/${lower}s/:id`, handler: `get${m.name}`,    produces: m.name },
      { method: 'PUT',    path: `/api/${lower}s/:id`, handler: `update${m.name}`, consumes: m.name, produces: m.name },
      { method: 'DELETE', path: `/api/${lower}s/:id`, handler: `delete${m.name}` },
    );
  }

  const schema: SchemaSpec = { tables: dataModels.map((m) => ({
    name: m.name.toLowerCase() + 's',
    columns: m.fields.map((f) => ({ name: f.name, type: f.type })),
  }))};

  return {
    logic: {
      dataModels,
      rules: planner.requirements
        .filter((r) => r.type === 'functional')
        .map((r) => ({ name: r.id, description: r.description })),
    },
    apiRoutes,
    schema,
  };
}

function singularize(s: string): string {
  if (s.endsWith('ies')) return s.slice(0, -3) + 'y';
  if (s.endsWith('ses')) return s.slice(0, -2);
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}
