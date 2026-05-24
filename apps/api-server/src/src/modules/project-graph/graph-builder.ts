/**
 * Project Dependency Graph Builder (Task #18 — Stage 14.5 support).
 *
 * Builds a typed graph of every generated file and the cross-file relationships
 * between them. Nodes cover files, components, hooks, routes, and api-clients;
 * edges cover imports, exports, route-handler bindings, and api-call→endpoint
 * pairings. The output drives the post-test verification stage and feeds the
 * auto-fix loop with `errorType: 'graph'` errors.
 *
 * Implementation is pure regex + Set lookups so it runs in well under 100ms
 * on typical generations and never depends on a parser. The same parsing
 * style is used by `import-validator.ts` and `cross-file-validator.ts`.
 */

export interface GraphFile {
  path: string;
  content: string;
  language?: string;
}

export type GraphNodeKind = 'file' | 'component' | 'hook' | 'route' | 'api-client';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  /** File this node lives in (for file nodes this is the file path itself). */
  file: string;
  /** Display name (component/hook/handler name, route path, etc.). */
  name: string;
  /** Optional HTTP method for route nodes / api-client call nodes. */
  method?: string;
  /** 1-based line number where the node was discovered, when available. */
  line?: number;
}

export type GraphEdgeKind = 'import' | 'export' | 'route-handler' | 'api-call-to-endpoint';

export interface GraphEdge {
  kind: GraphEdgeKind;
  from: string;          // node id
  to: string;            // node id (or symbolic id for unresolved targets)
  /** Free-form label — import specifier, exported symbol name, etc. */
  label?: string;
}

export interface ProjectGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Quick lookup helpers populated alongside nodes/edges. */
  byKind: Record<GraphNodeKind, GraphNode[]>;
  /** Per-file summary. */
  filesIndexed: number;
}

const NODE_BUILTINS = new Set<string>([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'crypto', 'dgram', 'dns', 'events', 'fs', 'http', 'http2', 'https',
  'module', 'net', 'os', 'path', 'process', 'querystring', 'readline',
  'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util',
  'v8', 'vm', 'worker_threads', 'zlib',
]);

const INTERNAL_ALIAS_PREFIXES = ['@/', '~/', '#/'];

/**
 * Default alias map used when a project does not declare its own. Mirrors the
 * conventions baked into the AutoCoder generators (Vite + tsconfig "paths"
 * usually map @/* → src/*). Keeping this small avoids false positives where
 * a perfectly valid `@/components/Foo` import would otherwise be reported as
 * unresolved by Stage 14.5.
 */
const DEFAULT_ALIAS_MAP: Record<string, string> = {
  '@/': 'src/',
  '~/': 'src/',
  '#/': 'src/',
};

/** Try to resolve a tsconfig.json/jsconfig.json "paths" map from the file set. */
function loadAliasMap(files: GraphFile[]): Record<string, string> {
  const map: Record<string, string> = { ...DEFAULT_ALIAS_MAP };
  for (const f of files) {
    if (!/(?:^|\/)(?:ts|js)config(?:\.[\w.-]+)?\.json$/.test(f.path)) continue;
    try {
      const cfg = JSON.parse(f.content) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
      const baseUrl = (cfg.compilerOptions?.baseUrl || '.').replace(/\/$/, '');
      const paths = cfg.compilerOptions?.paths || {};
      for (const key of Object.keys(paths)) {
        const target = paths[key]?.[0];
        if (!target) continue;
        // Convert "@/*" → prefix "@/" and target "src/" (strip "/*" on both sides)
        const prefix = key.endsWith('/*') ? key.slice(0, -1) : key;
        const resolved = target.endsWith('/*') ? target.slice(0, -1) : target;
        const dest = (baseUrl ? `${baseUrl}/` : '') + resolved.replace(/^\.\//, '');
        map[prefix] = dest.replace(/^\/+/, '');
      }
    } catch { /* malformed config — keep defaults */ }
  }
  return map;
}

function resolveAliased(spec: string, aliasMap: Record<string, string>): string | null {
  for (const prefix of Object.keys(aliasMap)) {
    if (spec.startsWith(prefix)) return aliasMap[prefix] + spec.slice(prefix.length);
  }
  return null;
}

export function fileNodeId(path: string): string { return `file:${path}`; }
export function componentNodeId(path: string, name: string): string { return `component:${path}#${name}`; }
export function hookNodeId(path: string, name: string): string { return `hook:${path}#${name}`; }
export function routeNodeId(method: string, routePath: string): string { return `route:${method.toUpperCase()} ${routePath}`; }
export function apiClientNodeId(path: string, line: number, method: string, url: string): string {
  return `api-client:${path}:${line}#${method.toUpperCase()} ${url}`;
}

function isCodeFile(path: string): boolean {
  return /\.(?:m?[jt]sx?|cjs|mjs)$/i.test(path);
}

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}

function isInternalAlias(spec: string): boolean {
  return INTERNAL_ALIAS_PREFIXES.some(p => spec === p.replace(/\/$/, '') || spec.startsWith(p));
}

function isExternalPackage(spec: string): boolean {
  if (!spec || !spec.length) return false;
  if (isRelative(spec)) return false;
  if (spec.startsWith('/')) return false;
  if (spec.startsWith('node:')) return false;
  if (NODE_BUILTINS.has(spec.split('/')[0])) return false;
  if (isInternalAlias(spec)) return false;
  return true;
}

/** Resolve a relative import specifier against the importer's directory. */
function resolveRelative(importerPath: string, spec: string): string {
  const importerDir = importerPath.includes('/')
    ? importerPath.slice(0, importerPath.lastIndexOf('/'))
    : '';
  const segs = (importerDir ? importerDir.split('/') : []).concat(spec.split('/'));
  const stack: string[] = [];
  for (const s of segs) {
    if (!s || s === '.') continue;
    if (s === '..') stack.pop();
    else stack.push(s);
  }
  return stack.join('/');
}

const CANDIDATE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function findResolvedFile(base: string, byPath: Map<string, GraphFile>): GraphFile | null {
  for (const ext of CANDIDATE_EXTS) {
    const candidate = `${base}${ext}`;
    const f = byPath.get(candidate);
    if (f) return f;
  }
  return null;
}

interface RawImport { spec: string; line: number; resolved?: GraphFile | null; }

function extractImports(content: string): RawImport[] {
  const out: RawImport[] = [];
  const RE = /(?:^|[\s;])(?:import\s+[^'"]*?from\s+|import\s+|export\s+[^'"]*?from\s+|require\s*\(\s*|import\s*\(\s*)(['"])([^'"\n]+)\1\s*\)?/gm;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(content)) !== null) {
    const spec = m[2];
    if (!spec) continue;
    const line = (content.slice(0, m.index).match(/\n/g)?.length || 0) + 1;
    out.push({ spec, line });
  }
  return out;
}

interface ExportSym { name: string; isDefault: boolean; line: number; }

function extractExports(content: string): ExportSym[] {
  const out: ExportSym[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dm = line.match(/export\s+default\s+(?:async\s+)?(?:function|class)\s+(\w+)/);
    if (dm) {
      out.push({ name: dm[1], isDefault: true, line: i + 1 });
      out.push({ name: 'default', isDefault: true, line: i + 1 });
      continue;
    }
    if (/export\s+default\s+/.test(line)) {
      out.push({ name: 'default', isDefault: true, line: i + 1 });
    }
    const nm = line.match(/export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/);
    if (nm) out.push({ name: nm[1], isDefault: false, line: i + 1 });
    const re = line.match(/export\s*\{([^}]+)\}/);
    if (re) {
      for (const part of re[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) out.push({ name, isDefault: false, line: i + 1 });
      }
    }
  }
  return out;
}

interface ImportedNames { defaultName?: string; named: string[]; spec: string; line: number; }

function extractImportNames(content: string): ImportedNames[] {
  const out: ImportedNames[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/import\s+(?:type\s+)?(?:(\w+)\s*(?:,\s*\{([^}]+)\})?|\{([^}]+)\}|\*\s+as\s+\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (!m) continue;
    const named: string[] = [];
    if (m[2]) named.push(...m[2].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
    if (m[3]) named.push(...m[3].split(',').map(n => {
      let s = n.trim();
      if (s.startsWith('type ')) s = s.slice(5).trim();
      return s.split(/\s+as\s+/)[0].trim();
    }).filter(Boolean));
    out.push({ defaultName: m[1] || undefined, named, spec: m[4], line: i + 1 });
  }
  return out;
}

/** Detects exported React components and custom hooks by name + heuristics. */
function findComponentsAndHooks(file: GraphFile, exports: ExportSym[]): { components: string[]; hooks: string[] } {
  const components: string[] = [];
  const hooks: string[] = [];
  const isFrontend = /\.(?:tsx|jsx)$/.test(file.path) || file.path.includes('/components/') || file.path.includes('/pages/');
  for (const e of exports) {
    if (e.name === 'default') continue;
    if (/^use[A-Z]\w*/.test(e.name)) {
      hooks.push(e.name);
      continue;
    }
    if (isFrontend && /^[A-Z]\w*/.test(e.name)) {
      components.push(e.name);
    }
  }
  return { components, hooks };
}

interface RawRoute { method: string; routePath: string; line: number; }

function extractRoutes(file: GraphFile): RawRoute[] {
  if (!/(routes|server)/.test(file.path) && !/\.(?:ts|js)$/.test(file.path)) return [];
  const out: RawRoute[] = [];
  const lines = file.content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/i);
    if (m) out.push({ method: m[1].toUpperCase(), routePath: m[2], line: i + 1 });
  }
  return out;
}

interface RawApiCall { method: string; url: string; line: number; }

function extractApiCalls(file: GraphFile): RawApiCall[] {
  if (!/\.(?:tsx?|jsx?|mjs|cjs)$/i.test(file.path)) return [];
  const out: RawApiCall[] = [];
  const lines = file.content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/(?:fetch|apiRequest|axios(?:\.\w+)?)\s*\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*\{[^}]*method\s*:\s*['"`](\w+)['"`])?/);
    if (f) {
      const url = f[1];
      if (url.startsWith('/api') || url.startsWith('/')) {
        out.push({ method: (f[2] || 'GET').toUpperCase(), url, line: i + 1 });
      }
    }
    const q = line.match(/queryKey\s*:\s*\[?\s*['"`](\/[^'"`]+)['"`]/);
    if (q) out.push({ method: 'GET', url: q[1], line: i + 1 });
  }
  return out;
}

/**
 * Build the full project graph. Always returns a graph (never throws);
 * malformed files contribute no edges but still appear as file nodes.
 */
export function buildProjectGraph(files: GraphFile[]): ProjectGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const byKind: Record<GraphNodeKind, GraphNode[]> = {
    file: [], component: [], hook: [], route: [], 'api-client': [],
  };
  const byPath = new Map<string, GraphFile>();
  for (const f of files) byPath.set(f.path, f);
  const aliasMap = loadAliasMap(files);

  // HTML entry-point pass: index.html is the *real* entry point for vite/
  // react apps. Its `<script src="...">` references behave like imports —
  // if they target a missing file the app cannot boot. The graph builder
  // models them as `import` edges from a synthetic file node so the
  // verifier surfaces a missing `src/main.tsx` exactly like a missing TS
  // import. Without this pass the 2026-05-10 portfolio bug (no main.tsx,
  // graph reports clean) recurs silently.
  // The main pre-pass below adds a `file` node for every input file
  // (including index.html). We only emit the script-src edges here; the
  // node registration happens once, in the loop that follows.
  for (const f of files) {
    if (!/(^|\/)index\.html$/.test(f.path) || !f.content) continue;
    const fromId = fileNodeId(f.path);
    const re = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content)) !== null) {
      const spec = m[1];
      if (!spec || /^https?:/.test(spec)) continue;
      let resolvedPath: string | null = null;
      if (spec.startsWith('/')) {
        const trimmed = spec.replace(/^\/+/, '');
        const hit = byPath.get(trimmed) ?? findResolvedFile(trimmed, byPath);
        resolvedPath = hit?.path ?? null;
      } else {
        const base = resolveRelative(f.path, spec);
        resolvedPath = findResolvedFile(base, byPath)?.path ?? null;
      }
      const target = resolvedPath ? fileNodeId(resolvedPath) : `unresolved:${spec}`;
      edges.push({ kind: 'import', from: fromId, to: target, label: spec });
    }
  }

  // Pre-pass: collect every file node + its exports/components/hooks/routes
  const exportMap = new Map<string, ExportSym[]>();
  for (const f of files) {
    const fileNode: GraphNode = { id: fileNodeId(f.path), kind: 'file', file: f.path, name: f.path };
    nodes.push(fileNode);
    byKind.file.push(fileNode);
    if (!isCodeFile(f.path) || !f.content) continue;
    let exps: ExportSym[] = [];
    try { exps = extractExports(f.content); } catch { exps = []; }
    exportMap.set(f.path, exps);
    for (const e of exps) {
      edges.push({ kind: 'export', from: fileNode.id, to: `symbol:${f.path}#${e.name}`, label: e.name });
    }
    const { components, hooks } = findComponentsAndHooks(f, exps);
    for (const c of components) {
      const n: GraphNode = { id: componentNodeId(f.path, c), kind: 'component', file: f.path, name: c };
      nodes.push(n); byKind.component.push(n);
    }
    for (const h of hooks) {
      const n: GraphNode = { id: hookNodeId(f.path, h), kind: 'hook', file: f.path, name: h };
      nodes.push(n); byKind.hook.push(n);
    }
    const routes = extractRoutes(f);
    for (const r of routes) {
      const id = routeNodeId(r.method, r.routePath);
      const n: GraphNode = { id, kind: 'route', file: f.path, name: r.routePath, method: r.method, line: r.line };
      nodes.push(n); byKind.route.push(n);
      edges.push({ kind: 'route-handler', from: fileNodeId(f.path), to: id, label: `${r.method} ${r.routePath}` });
    }
  }

  // Second pass: resolve imports + api-call edges
  for (const f of files) {
    if (!isCodeFile(f.path) || !f.content) continue;
    const named = extractImportNames(f.content);
    const allImports = extractImports(f.content);

    // Track which (spec,line) pairs were already covered by `named` to avoid
    // duplicating side-effect / re-export edges.
    const seen = new Set<string>();
    const resolveSpec = (spec: string): string => {
      if (isExternalPackage(spec)) return `package:${spec.split('/')[0]}`;
      let base: string;
      if (isRelative(spec)) base = resolveRelative(f.path, spec);
      else if (isInternalAlias(spec)) {
        const aliased = resolveAliased(spec, aliasMap);
        base = aliased ?? spec;
      } else base = spec;
      const resolved = findResolvedFile(base, byPath);
      return resolved ? fileNodeId(resolved.path) : `unresolved:${spec}`;
    };

    for (const im of named) {
      seen.add(`${im.spec}@${im.line}`);
      const target = resolveSpec(im.spec);
      const label = im.defaultName
        ? `${im.defaultName}${im.named.length ? `, {${im.named.join(', ')}}` : ''}`
        : (im.named.length ? `{${im.named.join(', ')}}` : '*');
      edges.push({ kind: 'import', from: fileNodeId(f.path), to: target, label });
    }
    for (const im of allImports) {
      if (seen.has(`${im.spec}@${im.line}`)) continue;
      edges.push({ kind: 'import', from: fileNodeId(f.path), to: resolveSpec(im.spec), label: im.spec });
    }

    const apiCalls = extractApiCalls(f);
    for (const c of apiCalls) {
      const node: GraphNode = {
        id: apiClientNodeId(f.path, c.line, c.method, c.url),
        kind: 'api-client', file: f.path, name: c.url, method: c.method, line: c.line,
      };
      nodes.push(node); byKind['api-client'].push(node);
      // Try to match a backend route node
      const match = matchApiCallToRoute(c, byKind.route);
      const to = match ? match.id : `unresolved-route:${c.method} ${c.url}`;
      edges.push({ kind: 'api-call-to-endpoint', from: node.id, to, label: `${c.method} ${c.url}` });
    }
  }

  return { nodes, edges, byKind, filesIndexed: files.length };
}

function matchApiCallToRoute(call: { method: string; url: string }, routes: GraphNode[]): GraphNode | null {
  // Strip query string + template-literal interpolations
  const normalizedCallUrl = call.url.replace(/\?.*$/, '').replace(/\$\{[^}]+\}/g, ':param');
  for (const r of routes) {
    if (r.method !== call.method) continue;
    if (!r.name) continue;
    const route = r.name;
    if (route === normalizedCallUrl) return r;
    // Express-style :param matching
    const routePattern = '^' + route.replace(/:[^/]+/g, '[^/]+').replace(/\//g, '\\/') + '$';
    try {
      if (new RegExp(routePattern).test(normalizedCallUrl)) return r;
      // Loose match — frontend may include extra trailing path segments
      if (new RegExp(routePattern.replace('$', '(\\/.*)?$')).test(normalizedCallUrl)) return r;
    } catch { /* malformed regex — skip */ }
  }
  return null;
}
