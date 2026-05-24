/**
 * SYSTEM — Backend logic owner (Fusion mode).
 * Wraps AutoCoder's `schema-designer.designSchema` and `api-designer.designAPI`.
 * Writes results back to legacyCtx.schemaDesign / legacyCtx.apiDesign so the
 * downstream codegen pipeline (Coder) can consume them.
 *
 * Reads:  legacyCtx.plan, legacyCtx.reasoning, legacyCtx.detectedDomain
 * Writes: SystemOutput { logic, apiRoutes, schema }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import type { AgentRunContext } from '../agent-runner.js';
import type {
  ApiRoute,
  ArchitectOutput,
  DataModel,
  PlannerOutput,
  SchemaSpec,
  SystemOutput,
} from '../types.js';

export async function runSystem(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<SystemOutput> {
  const architect = ledger.read('System', 'architect') as ArchitectOutput | null;
  const planner = ledger.read('System', 'planner') as PlannerOutput | null;
  if (!architect || !planner) throw new Error('System: missing architect/planner output');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = runCtx.legacyCtx as any | undefined;

  let realSchema: { tables?: Array<{ name: string; columns?: Array<{ name: string; type: string }> }> } | null = null;
  let realApi: { routes?: Array<{ method: string; path: string; handler?: string; consumes?: string; produces?: string }> } | null = null;

  if (ctx?.plan) {
    try {
      const sd = await import('../../schema-designer.js');
      const schemaDesign = sd.designSchema(ctx.plan, ctx.reasoning ?? null, ctx.detectedDomain);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      realSchema = schemaDesign as any;
      ctx.schemaDesign = schemaDesign;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[RuFlo:System] designSchema failed:', (e as Error).message);
    }
    try {
      const ad = await import('../../api-designer.js');
      const apiDesign = ad.designAPI(ctx.plan, ctx.reasoning ?? null, ctx.schemaDesign ?? null, ctx.detectedDomain);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      realApi = apiDesign as any;
      ctx.apiDesign = apiDesign;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[RuFlo:System] designAPI failed:', (e as Error).message);
    }
  }

  // Build data models — prefer plan.dataModel, fallback to architect modules.
  const dataModels: DataModel[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const planModels = (ctx?.plan?.dataModel ?? []) as Array<any>;
  if (planModels.length > 0) {
    for (const e of planModels) {
      dataModels.push({
        name: String(e.name),
        fields: (e.fields ?? []).map((f: { name: string; type: string; required?: boolean }) => ({
          name: f.name, type: f.type, required: !!f.required,
        })),
      });
    }
  } else {
    const entities = new Set<string>();
    for (const m of architect.architecture.modules) {
      const stripped = m.name.replace(/(Page|Panel|Dashboard|View|List|Form|Api|Manage)$/i, '');
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
  }

  // Build API routes — prefer real api design, fallback to CRUD per entity.
  const apiRoutes: ApiRoute[] = [];
  if (realApi?.routes?.length) {
    for (const r of realApi.routes) {
      apiRoutes.push({
        method: (r.method as ApiRoute['method']) ?? 'GET',
        path: r.path,
        handler: r.handler ?? `${r.method.toLowerCase()}${r.path.replace(/\W+/g, '')}`,
        consumes: r.consumes,
        produces: r.produces,
      });
    }
  } else {
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
  }

  // Build SchemaSpec.
  const schema: SchemaSpec = realSchema?.tables?.length
    ? { tables: realSchema.tables.map((t) => ({
        name: t.name,
        columns: (t.columns ?? []).map((c) => ({ name: c.name, type: c.type })),
      }))}
    : { tables: dataModels.map((m) => ({
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
