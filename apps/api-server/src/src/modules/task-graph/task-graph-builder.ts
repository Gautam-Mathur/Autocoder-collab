/**
 * Task Graph Builder — converts a ProjectPlan into a dependency graph
 *
 * Nodes represent code-generation tasks (one per file to be generated).
 * Edges represent "must exist before" relationships.
 * Layers are groups of nodes that can be generated in parallel (no inter-layer deps).
 *
 * Example output:
 *   Layer 0: [db/schema.ts]
 *   Layer 1: [server/routes/*.ts, server/services/*.ts]
 *   Layer 2: [client/hooks/*.ts, client/store.ts]
 *   Layer 3: [client/pages/*.tsx, client/components/*.tsx]
 *   Layer 4: [tests/**, README.md, Dockerfile]
 */

import type { ProjectPlan, PlannedEntity, PlannedEndpoint, PlannedPage } from '../plan-generator.js';

export type TaskKind =
  | 'schema'
  | 'migration'
  | 'seed'
  | 'service'
  | 'route'
  | 'middleware'
  | 'hook'
  | 'store'
  | 'page'
  | 'component'
  | 'test'
  | 'config'
  | 'doc';

export interface GenerationTask {
  id: string;
  kind: TaskKind;
  label: string;
  targetPath: string;
  /** IDs of tasks that must complete before this one */
  dependsOn: string[];
  /** context passed to codegen */
  meta: Record<string, unknown>;
}

export interface TaskGraph {
  tasks: Map<string, GenerationTask>;
  /** Each inner array is a set of tasks that can run in parallel */
  layers: GenerationTask[][];
}

function makeId(kind: TaskKind, name: string): string {
  return `${kind}:${name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;
}

// ── Dependency rules ──────────────────────────────────────────────────────

/** Returns the layer tier for a task kind (lower = runs first) */
function layerFor(kind: TaskKind): number {
  switch (kind) {
    case 'schema':    return 0;
    case 'migration': return 1;
    case 'seed':      return 1;
    case 'service':   return 1;
    case 'route':     return 1;
    case 'middleware':return 1;
    case 'hook':      return 2;
    case 'store':     return 2;
    case 'page':      return 3;
    case 'component': return 3;
    case 'test':      return 4;
    case 'config':    return 1;
    case 'doc':       return 4;
    default:          return 3;
  }
}

// ── Builder ───────────────────────────────────────────────────────────────

export function buildTaskGraph(plan: ProjectPlan): TaskGraph {
  const tasks = new Map<string, GenerationTask>();
  const maxLayer = 5;
  const layerBuckets: GenerationTask[][] = Array.from({ length: maxLayer }, () => []);

  const addTask = (t: GenerationTask) => {
    tasks.set(t.id, t);
    const layer = Math.min(layerFor(t.kind), maxLayer - 1);
    layerBuckets[layer].push(t);
  };

  // ── Entities → schema tasks ────────────────────────────────────────────
  const schemaTaskIds: string[] = [];

  for (const entity of plan.dataModel ?? []) {
    const id = makeId('schema', entity.name);
    addTask({
      id,
      kind: 'schema',
      label: `Schema: ${entity.name}`,
      targetPath: `db/schema/${entity.name.toLowerCase()}.ts`,
      dependsOn: [],
      meta: { entity },
    });
    schemaTaskIds.push(id);
  }

  // One combined migration task after all schemas
  if (schemaTaskIds.length) {
    addTask({
      id: 'schema:combined-migration',
      kind: 'migration',
      label: 'DB migration',
      targetPath: 'db/migrations/001_init.sql',
      dependsOn: schemaTaskIds,
      meta: { entities: plan.dataModel },
    });
  }

  // ── Modules → service + route tasks ────────────────────────────────────
  const serviceTaskIds: string[] = [];

  for (const mod of plan.modules ?? []) {
    const svcId = makeId('service', mod.name);
    addTask({
      id: svcId,
      kind: 'service',
      label: `Service: ${mod.name}`,
      targetPath: `server/services/${mod.name.toLowerCase()}.service.ts`,
      dependsOn: schemaTaskIds,
      meta: { module: mod },
    });
    serviceTaskIds.push(svcId);

    const routeId = makeId('route', mod.name);
    addTask({
      id: routeId,
      kind: 'route',
      label: `Route: ${mod.name}`,
      targetPath: `server/routes/${mod.name.toLowerCase()}.routes.ts`,
      dependsOn: [svcId],
      meta: { module: mod },
    });
  }

  // ── Endpoints not covered by modules ─────────────────────────────────
  for (const ep of plan.apiEndpoints ?? []) {
    const epId = makeId('route', `${ep.method}-${ep.path}`);
    if (!tasks.has(epId)) {
      addTask({
        id: epId,
        kind: 'route',
        label: `Endpoint: ${ep.method} ${ep.path}`,
        targetPath: `server/routes/${ep.path.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.ts`,
        dependsOn: schemaTaskIds,
        meta: { endpoint: ep },
      });
    }
  }

  // ── Pages → component tasks ────────────────────────────────────────────
  const hookTaskIds: string[] = [];

  for (const page of plan.pages ?? []) {
    const hookId = makeId('hook', page.name);
    addTask({
      id: hookId,
      kind: 'hook',
      label: `Hook: use${page.name}`,
      targetPath: `client/hooks/use${page.name}.ts`,
      dependsOn: serviceTaskIds,
      meta: { page },
    });
    hookTaskIds.push(hookId);

    const pageId = makeId('page', page.name);
    addTask({
      id: pageId,
      kind: 'page',
      label: `Page: ${page.name}`,
      targetPath: `client/pages/${page.name}.tsx`,
      dependsOn: [hookId],
      meta: { page },
    });

    for (const feature of page.features ?? []) {
      const compId = makeId('component', `${page.name}-${feature}`);
      addTask({
        id: compId,
        kind: 'component',
        label: `Component: ${page.name}/${feature}`,
        targetPath: `client/components/${page.name}/${feature}.tsx`,
        dependsOn: [pageId],
        meta: { page, feature },
      });
    }
  }

  // ── Tests ────────────────────────────────────────────────────────────
  const allPriorIds = [...tasks.keys()].filter(id => !id.startsWith('test:'));

  if ((plan as any).testingStrategy !== 'none') {
    for (const entity of plan.dataModel ?? []) {
      const testId = makeId('test', entity.name);
      addTask({
        id: testId,
        kind: 'test',
        label: `Test: ${entity.name}`,
        targetPath: `tests/${entity.name.toLowerCase()}.test.ts`,
        dependsOn: allPriorIds.slice(0, 5), // avoid huge dep lists
        meta: { entity },
      });
    }
  }

  // ── Config / infra ────────────────────────────────────────────────────
  addTask({
    id: 'config:package-json',
    kind: 'config',
    label: 'package.json',
    targetPath: 'package.json',
    dependsOn: [],
    meta: { plan },
  });

  addTask({
    id: 'config:env-example',
    kind: 'config',
    label: '.env.example',
    targetPath: '.env.example',
    dependsOn: schemaTaskIds.slice(0, 1),
    meta: { plan },
  });

  // ── README ───────────────────────────────────────────────────────────
  addTask({
    id: 'doc:readme',
    kind: 'doc',
    label: 'README.md',
    targetPath: 'README.md',
    dependsOn: allPriorIds.slice(0, 3),
    meta: { plan },
  });

  const layers = layerBuckets.filter(l => l.length > 0);
  console.log(`[TaskGraph] Built ${tasks.size} tasks across ${layers.length} layers`);

  return { tasks, layers };
}
