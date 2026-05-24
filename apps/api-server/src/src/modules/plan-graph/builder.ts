/**
 * Initiative D — Plan-as-Graph
 *
 * Pure transform from a `ProjectPlan` into a renderable `{nodes, edges}` graph.
 * Each entity, page, and route becomes a node; relationships between them
 * become edges. Used by both the chat UI (visual plan view) and the dry-run
 * preview endpoint.
 *
 * Node positions are computed deterministically (column by kind, row by
 * insertion order) so the same plan always renders the same way — no
 * physics simulation, no React Flow runtime dep needed.
 */

import type { ProjectPlan, PlannedEntity, PlannedPage } from '../plan-generator.js';

export type PlanNodeKind = 'project' | 'entity' | 'page' | 'route' | 'integration';

export interface PlanNode {
  id: string;
  kind: PlanNodeKind;
  label: string;
  /** Sub-text shown below the label. */
  detail?: string;
  /** Deterministic layout position. */
  x: number;
  y: number;
  /** Free-form metadata for the chat UI to render badges. */
  meta?: Record<string, unknown>;
}

export type PlanEdgeKind = 'relationship' | 'page-uses-entity' | 'route-targets-entity' | 'integration-of';

export interface PlanEdge {
  id: string;
  source: string;
  target: string;
  kind: PlanEdgeKind;
  label?: string;
}

export interface PlanGraph {
  nodes: PlanNode[];
  edges: PlanEdge[];
  stats: {
    entities: number;
    pages: number;
    routes: number;
    integrations: number;
    relationships: number;
  };
}

const COLUMN_X: Record<PlanNodeKind, number> = {
  project: 40,
  entity: 280,
  page: 560,
  route: 840,
  integration: 1120,
};

const ROW_HEIGHT = 110;
const ROW_OFFSET_Y = 60;

function entityId(name: string): string {
  return `entity:${slug(name)}`;
}

function pageId(name: string): string {
  return `page:${slug(name)}`;
}

function routeId(method: string, path: string, idx: number): string {
  return `route:${slug(method)}:${slug(path)}:${idx}`;
}

function integrationId(name: string): string {
  return `integration:${slug(name)}`;
}

function slug(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function buildPlanGraph(plan: ProjectPlan | undefined | null): PlanGraph {
  const nodes: PlanNode[] = [];
  const edges: PlanEdge[] = [];

  if (!plan) {
    return {
      nodes: [],
      edges: [],
      stats: { entities: 0, pages: 0, routes: 0, integrations: 0, relationships: 0 },
    };
  }

  // Project root node.
  nodes.push({
    id: 'project:root',
    kind: 'project',
    label: plan.projectName || 'Project',
    detail: plan.overview ? plan.overview.slice(0, 80) : undefined,
    x: COLUMN_X.project,
    y: ROW_OFFSET_Y,
  });

  const entities: PlannedEntity[] = Array.isArray(plan.dataModel) ? plan.dataModel : [];
  const pages: PlannedPage[] = Array.isArray(plan.pages) ? plan.pages : [];
  const routes: any[] = Array.isArray((plan as any).apiEndpoints) ? (plan as any).apiEndpoints : [];
  const integrations: any[] = Array.isArray(plan.integrations) ? plan.integrations : [];

  // Entity nodes.
  let relationshipsCount = 0;
  entities.forEach((entity, i) => {
    nodes.push({
      id: entityId(entity.name),
      kind: 'entity',
      label: entity.name,
      detail: `${entity.fields?.length || 0} fields`,
      x: COLUMN_X.entity,
      y: ROW_OFFSET_Y + i * ROW_HEIGHT,
      meta: { fields: entity.fields?.map((f) => f.name) },
    });
    edges.push({
      id: `e:project:${entityId(entity.name)}`,
      source: 'project:root',
      target: entityId(entity.name),
      kind: 'page-uses-entity', // visual only
    });

    for (const rel of entity.relationships || []) {
      const targetExists = entities.find((e) => e.name === rel.entity);
      if (!targetExists) continue;
      edges.push({
        id: `r:${entityId(entity.name)}:${entityId(rel.entity)}`,
        source: entityId(entity.name),
        target: entityId(rel.entity),
        kind: 'relationship',
        label: rel.type,
      });
      relationshipsCount++;
    }
  });

  // Page nodes.
  pages.forEach((page, i) => {
    const id = pageId(page.name);
    nodes.push({
      id,
      kind: 'page',
      label: page.name,
      detail: page.path || undefined,
      x: COLUMN_X.page,
      y: ROW_OFFSET_Y + i * ROW_HEIGHT,
      meta: { features: page.features },
    });
    for (const need of page.dataNeeded || []) {
      const matched = entities.find((e) => e.name === need);
      if (!matched) continue;
      edges.push({
        id: `pe:${id}:${entityId(need)}`,
        source: id,
        target: entityId(need),
        kind: 'page-uses-entity',
      });
    }
  });

  // Route nodes.
  routes.forEach((route, i) => {
    const method = String(route.method || 'GET').toUpperCase();
    const path = String(route.path || route.url || '/');
    const id = routeId(method, path, i);
    nodes.push({
      id,
      kind: 'route',
      label: `${method} ${path}`,
      detail: route.description || undefined,
      x: COLUMN_X.route,
      y: ROW_OFFSET_Y + i * ROW_HEIGHT,
    });
    if (route.entity) {
      const matched = entities.find((e) => e.name === route.entity);
      if (matched) {
        edges.push({
          id: `re:${id}:${entityId(route.entity)}`,
          source: id,
          target: entityId(route.entity),
          kind: 'route-targets-entity',
        });
      }
    }
  });

  // Integration nodes.
  integrations.forEach((integration, i) => {
    const id = integrationId(integration.name || `integration-${i}`);
    nodes.push({
      id,
      kind: 'integration',
      label: integration.name || `Integration ${i + 1}`,
      detail: integration.purpose || integration.description,
      x: COLUMN_X.integration,
      y: ROW_OFFSET_Y + i * ROW_HEIGHT,
    });
    edges.push({
      id: `ip:${id}`,
      source: 'project:root',
      target: id,
      kind: 'integration-of',
    });
  });

  return {
    nodes,
    edges,
    stats: {
      entities: entities.length,
      pages: pages.length,
      routes: routes.length,
      integrations: integrations.length,
      relationships: relationshipsCount,
    },
  };
}
