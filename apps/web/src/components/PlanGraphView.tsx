/**
 * Initiative D — Plan-as-Graph
 *
 * Pure-SVG renderer for the deterministic plan graph returned by
 * `GET /api/conversations/:id/plan/graph` (or `POST /api/plan/graph`).
 *
 * No layout engine, no react-flow dependency — the server already places
 * nodes deterministically by kind/column, so we just paint them.
 */

import { useEffect, useState } from "react";

export interface PlanNode {
  id: string;
  kind: "project" | "entity" | "page" | "route" | "integration";
  label: string;
  detail?: string;
  x: number;
  y: number;
  meta?: Record<string, unknown>;
}

export interface PlanEdge {
  id: string;
  source: string;
  target: string;
  kind: "relationship" | "page-uses-entity" | "route-targets-entity" | "integration-of";
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

const NODE_WIDTH = 200;
const NODE_HEIGHT = 70;

const KIND_COLOR: Record<PlanNode["kind"], { fill: string; stroke: string; text: string }> = {
  project: { fill: "#0f172a", stroke: "#334155", text: "#f8fafc" },
  entity: { fill: "#1e3a8a", stroke: "#3b82f6", text: "#dbeafe" },
  page: { fill: "#14532d", stroke: "#22c55e", text: "#dcfce7" },
  route: { fill: "#78350f", stroke: "#f59e0b", text: "#fef3c7" },
  integration: { fill: "#581c87", stroke: "#a855f7", text: "#f3e8ff" },
};

const EDGE_COLOR: Record<PlanEdge["kind"], string> = {
  relationship: "#3b82f6",
  "page-uses-entity": "#22c55e",
  "route-targets-entity": "#f59e0b",
  "integration-of": "#a855f7",
};

export interface PlanGraphViewProps {
  /** Either pass a pre-fetched graph or a conversationId to fetch from the API. */
  graph?: PlanGraph;
  conversationId?: number;
  apiBase?: string;
  className?: string;
}

export function PlanGraphView({ graph, conversationId, apiBase = "/api", className }: PlanGraphViewProps) {
  const [data, setData] = useState<PlanGraph | null>(graph ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (graph) {
      setData(graph);
      return;
    }
    if (conversationId == null) return;
    let cancelled = false;
    fetch(`${apiBase}/conversations/${conversationId}/plan/graph`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((e) => { if (!cancelled) setError(String(e?.message || e)); });
    return () => { cancelled = true; };
  }, [graph, conversationId, apiBase]);

  if (error) return <div className={className}>Could not load plan graph: {error}</div>;
  if (!data) return <div className={className}>Loading plan graph…</div>;
  if (data.nodes.length === 0) return <div className={className}>No plan available yet.</div>;

  const maxX = Math.max(...data.nodes.map((n) => n.x)) + NODE_WIDTH + 40;
  const maxY = Math.max(...data.nodes.map((n) => n.y)) + NODE_HEIGHT + 40;
  const nodeMap = new Map(data.nodes.map((n) => [n.id, n]));

  return (
    <div className={className} style={{ overflow: "auto", border: "1px solid #1e293b", borderRadius: 8 }}>
      <div style={{ padding: 8, fontSize: 12, color: "#94a3b8", borderBottom: "1px solid #1e293b" }}>
        {data.stats.entities} entities · {data.stats.pages} pages · {data.stats.routes} routes ·{" "}
        {data.stats.integrations} integrations · {data.stats.relationships} relationships
      </div>
      <svg width={maxX} height={maxY} style={{ background: "#020617" }}>
        {/* edges */}
        {data.edges.map((edge) => {
          const s = nodeMap.get(edge.source);
          const t = nodeMap.get(edge.target);
          if (!s || !t) return null;
          const x1 = s.x + NODE_WIDTH;
          const y1 = s.y + NODE_HEIGHT / 2;
          const x2 = t.x;
          const y2 = t.y + NODE_HEIGHT / 2;
          const midX = (x1 + x2) / 2;
          const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
          return (
            <g key={edge.id}>
              <path d={path} stroke={EDGE_COLOR[edge.kind]} strokeWidth={1.5} fill="none" opacity={0.5} />
              {edge.label && (
                <text x={midX} y={(y1 + y2) / 2 - 4} fill="#64748b" fontSize={10} textAnchor="middle">
                  {edge.label}
                </text>
              )}
            </g>
          );
        })}
        {/* nodes */}
        {data.nodes.map((node) => {
          const c = KIND_COLOR[node.kind];
          return (
            <g key={node.id} transform={`translate(${node.x},${node.y})`}>
              <rect
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={8}
                fill={c.fill}
                stroke={c.stroke}
                strokeWidth={1.5}
              />
              <text x={12} y={24} fill={c.text} fontSize={13} fontWeight={600}>
                {truncate(node.label, 24)}
              </text>
              {node.detail && (
                <text x={12} y={44} fill={c.text} fontSize={11} opacity={0.75}>
                  {truncate(node.detail, 30)}
                </text>
              )}
              <text x={NODE_WIDTH - 8} y={14} fill={c.text} fontSize={9} textAnchor="end" opacity={0.6}>
                {node.kind.toUpperCase()}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
