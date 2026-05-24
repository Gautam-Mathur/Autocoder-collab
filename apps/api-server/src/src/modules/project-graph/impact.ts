/**
 * Change-impact propagation utility.
 *
 * Given a "seed" node in the ProjectGraph, returns the transitive set of
 * nodes that COULD be affected by a change to it — the basis on which any
 * future surgical / partial-regeneration mode would decide which stages to
 * re-run.
 *
 * NOT WIRED YET — exposed as a pure utility so a future caller (surgical
 * edit mode, plan-diff invalidation, etc.) can adopt it without re-deriving
 * the same traversal. Safe-default callers should fall back to a full run
 * if `getImpactSet` returns an empty set or if confidence is low.
 *
 * Symmetric: walks both forward edges (what *I* depend on) AND reverse
 * edges (what depends on *me*) — for change propagation the reverse
 * direction is what matters most (a schema change ripples *up* into the
 * UI, not down into the DB).
 */

import type { ProjectGraph, GraphEdge, GraphEdgeKind, GraphNode } from './graph-builder.js';

export interface ImpactOptions {
  /** Cap traversal depth so a hairball graph can't fan out to the whole repo. Default 5. */
  maxDepth?: number;
  /** Cap result size to avoid unbounded growth. Default 200. */
  maxNodes?: number;
  /**
   * Edge kinds to traverse. Default: all of them.
   * For schema-add propagation you typically want the full set so that
   * `entity → route-handler → api-client → component` is reachable.
   */
  edgeKinds?: GraphEdgeKind[];
}

export interface ImpactResult {
  /** Set of node ids affected (includes the seed). */
  nodes: Set<string>;
  /** Files containing those nodes — what a surgical re-run would target. */
  files: Set<string>;
  /** True if traversal was truncated by maxDepth or maxNodes. */
  truncated: boolean;
  /** Per-kind tally for debug surfaces. */
  byKind: Record<string, number>;
}

/** Compute the transitive impact set for a single seed node id. */
export function getImpactSet(
  graph: ProjectGraph,
  seed: string,
  opts: ImpactOptions = {},
): ImpactResult {
  const maxDepth = opts.maxDepth ?? 5;
  const maxNodes = opts.maxNodes ?? 200;
  const allowKind = opts.edgeKinds ? new Set(opts.edgeKinds) : null;

  const nodeIndex = new Map(graph.nodes.map((n) => [n.id, n] as const));
  if (!nodeIndex.has(seed)) {
    return { nodes: new Set(), files: new Set(), truncated: false, byKind: {} };
  }

  // Build adjacency once. Both directions (forward + reverse) matter for
  // change impact: an edit to an entity must propagate to its *callers*.
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    if (allowKind && !allowKind.has(e.kind)) continue;
    const o = out.get(e.from) ?? [];
    o.push(e);
    out.set(e.from, o);
    const i = inn.get(e.to) ?? [];
    i.push(e);
    inn.set(e.to, i);
  }

  const visited = new Set<string>([seed]);
  const queue: Array<{ id: string; depth: number }> = [{ id: seed, depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) {
      truncated = truncated || (out.get(id)?.length ?? 0) + (inn.get(id)?.length ?? 0) > 0;
      continue;
    }
    const neighbours = [
      ...(out.get(id) ?? []).map((e) => e.to),
      ...(inn.get(id) ?? []).map((e) => e.from),
    ];
    for (const next of neighbours) {
      if (visited.has(next)) continue;
      if (visited.size >= maxNodes) {
        truncated = true;
        break;
      }
      visited.add(next);
      queue.push({ id: next, depth: depth + 1 });
    }
  }

  const files = new Set<string>();
  const byKind: Record<string, number> = {};
  for (const id of visited) {
    const n = nodeIndex.get(id);
    if (!n) continue;
    if (n.file) files.add(n.file);
    byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  }
  return { nodes: visited, files, truncated, byKind };
}

/**
 * Convenience: union the impact sets of multiple seeds (e.g. all entities
 * touched by a single schema-add edit). Useful when a caller has a list of
 * names rather than node ids — pass `findNodesByName` first.
 */
export function getImpactSetForMany(
  graph: ProjectGraph,
  seeds: string[],
  opts: ImpactOptions = {},
): ImpactResult {
  const merged: ImpactResult = { nodes: new Set(), files: new Set(), truncated: false, byKind: {} };
  for (const s of seeds) {
    const r = getImpactSet(graph, s, opts);
    r.nodes.forEach((id) => merged.nodes.add(id));
    r.files.forEach((f) => merged.files.add(f));
    merged.truncated = merged.truncated || r.truncated;
    for (const [k, v] of Object.entries(r.byKind)) {
      merged.byKind[k] = (merged.byKind[k] ?? 0) + v;
    }
  }
  return merged;
}

/**
 * Find all nodes whose `name` matches the given string. Useful when callers
 * have entity / route names (e.g. from a NL classification) rather than
 * pre-computed graph node ids.
 */
export function findNodesByName(graph: ProjectGraph, name: string): GraphNode[] {
  return graph.nodes.filter((n) => n.name === name);
}
