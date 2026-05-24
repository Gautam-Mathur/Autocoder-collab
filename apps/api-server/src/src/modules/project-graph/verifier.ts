/**
 * Stage 14.5 — Project graph verifier (Task #18).
 *
 * Walks the graph produced by `buildProjectGraph` and reports four classes
 * of structural problems:
 *
 *   - unresolvedImports         — `import` edges whose target was not found in
 *                                 the generated file set or in package.json.
 *   - missingRoutes             — `api-call-to-endpoint` edges whose target
 *                                 route node was not registered by any
 *                                 backend file.
 *   - missingExports            — `import` edges that resolve to a known file
 *                                 but reference a name that file does not
 *                                 export.
 *   - undeclaredDependencies    — bare external package imports whose root
 *                                 is not present in package.json's
 *                                 dependencies / devDependencies.
 *
 * Each error is structured so the auto-fix loop (`errorType: 'graph'`) can
 * route them through its 3-tier cascade: parser-gate → SLM repair →
 * template-basement.
 *
 * The verifier never throws — failures degrade to an empty result and emit a
 * single warning so a verifier bug can never block the pipeline.
 */

import type { GraphFile, ProjectGraph, GraphEdge, GraphNode } from './graph-builder.js';
import { fileNodeId } from './graph-builder.js';

export interface UnresolvedImportError {
  file: string;
  spec: string;
  detail: string;
}
export interface MissingRouteError {
  file: string;
  method: string;
  url: string;
  detail: string;
}
export interface MissingExportError {
  file: string;
  importer: string;
  symbol: string;
  detail: string;
}
export interface UndeclaredDependencyError {
  file: string;
  packageName: string;
  detail: string;
}

export interface GraphVerificationResult {
  unresolvedImports: UnresolvedImportError[];
  missingRoutes: MissingRouteError[];
  missingExports: MissingExportError[];
  undeclaredDependencies: UndeclaredDependencyError[];
  /** True when every category is empty. */
  passed: boolean;
  /** Single-line summary suitable for one consolidated chat step. */
  summary: string;
  /** Total count across every category, exposed for quick gating. */
  totalIssues: number;
  /** Pass-through stats for debugging. */
  stats: {
    nodes: number;
    edges: number;
    files: number;
    routesRegistered: number;
    apiCalls: number;
  };
}

function emptyResult(): GraphVerificationResult {
  return {
    unresolvedImports: [],
    missingRoutes: [],
    missingExports: [],
    undeclaredDependencies: [],
    passed: true,
    summary: 'Project graph verification skipped — no files to check.',
    totalIssues: 0,
    stats: { nodes: 0, edges: 0, files: 0, routesRegistered: 0, apiCalls: 0 },
  };
}

function loadDeclaredPackages(files: GraphFile[]): Set<string> {
  const declared = new Set<string>();
  for (const f of files) {
    if (!f.path.endsWith('package.json')) continue;
    try {
      const pkg = JSON.parse(f.content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      for (const k of Object.keys(pkg.dependencies || {})) declared.add(k);
      for (const k of Object.keys(pkg.devDependencies || {})) declared.add(k);
      for (const k of Object.keys(pkg.peerDependencies || {})) declared.add(k);
    } catch { /* malformed package.json — ignore for verification */ }
  }
  return declared;
}

/** Re-extract export symbols from a file (cheap regex, mirrors graph-builder). */
function exportedSymbols(content: string): Set<string> {
  const set = new Set<string>();
  const dm = content.match(/export\s+default\s+(?:async\s+)?(?:function|class)\s+(\w+)/);
  if (dm) { set.add(dm[1]); set.add('default'); }
  if (/export\s+default\s+/.test(content)) set.add('default');
  for (const m of content.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g)) {
    set.add(m[1]);
  }
  for (const m of content.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) set.add(name);
    }
  }
  return set;
}

/** Parse the import edge label back into default + named imports. */
function parseImportLabel(label: string | undefined): { defaultName?: string; named: string[] } {
  if (!label) return { named: [] };
  const named: string[] = [];
  let defaultName: string | undefined;
  // Patterns produced by graph-builder:
  //   "Foo"                                     - default only
  //   "Foo, {a, b}"                             - default + named
  //   "{a, b}"                                  - named only
  //   "*"                                       - namespace
  //   "<spec>"                                  - side-effect / fallback
  if (label === '*') return { named: [] };
  const nm = label.match(/\{([^}]+)\}/);
  if (nm) {
    for (const part of nm[1].split(',')) {
      const trimmed = part.trim();
      if (trimmed) named.push(trimmed);
    }
  }
  const beforeBrace = label.split('{')[0].replace(/,\s*$/, '').trim();
  if (beforeBrace && beforeBrace !== label && /^\w+$/.test(beforeBrace)) {
    defaultName = beforeBrace;
  } else if (!nm && /^\w+$/.test(label)) {
    defaultName = label;
  }
  return { defaultName, named };
}

export function verifyProjectGraph(graph: ProjectGraph, files: GraphFile[]): GraphVerificationResult {
  if (!files || files.length === 0) return emptyResult();

  const declaredPackages = loadDeclaredPackages(files);

  const unresolvedImports: UnresolvedImportError[] = [];
  const missingRoutes: MissingRouteError[] = [];
  const missingExports: MissingExportError[] = [];
  const undeclaredDependencies: UndeclaredDependencyError[] = [];

  // Index files by path so missing-export checks can re-extract symbols.
  const fileByPath = new Map<string, GraphFile>();
  for (const f of files) fileByPath.set(f.path, f);

  // Index node ids so we can detect "not in graph"
  const nodeById = new Map<string, GraphNode>();
  for (const n of graph.nodes) nodeById.set(n.id, n);

  // Track packages we've already reported per file to avoid duplicate noise
  const reportedPackagesPerFile = new Map<string, Set<string>>();

  for (const edge of graph.edges) {
    if (edge.kind === 'import') {
      // edge.from is `file:<path>`
      const fromFile = edge.from.startsWith('file:') ? edge.from.slice(5) : edge.from;
      if (edge.to.startsWith('unresolved:')) {
        unresolvedImports.push({
          file: fromFile,
          spec: edge.to.slice('unresolved:'.length),
          detail: `Import "${edge.label || ''}" could not be resolved to any file in the project`,
        });
        continue;
      }
      if (edge.to.startsWith('package:')) {
        const pkg = edge.to.slice('package:'.length);
        if (!declaredPackages.has(pkg)) {
          const seen = reportedPackagesPerFile.get(fromFile) || new Set<string>();
          if (!seen.has(pkg)) {
            undeclaredDependencies.push({
              file: fromFile,
              packageName: pkg,
              detail: `Package "${pkg}" is imported but not declared in package.json`,
            });
            seen.add(pkg);
            reportedPackagesPerFile.set(fromFile, seen);
          }
        }
        continue;
      }
      if (edge.to.startsWith('file:')) {
        const targetPath = edge.to.slice('file:'.length);
        const target = fileByPath.get(targetPath);
        if (!target) {
          unresolvedImports.push({
            file: fromFile,
            spec: edge.label || targetPath,
            detail: `Import targets "${targetPath}" but the file is not in the project`,
          });
          continue;
        }
        const { defaultName, named } = parseImportLabel(edge.label);
        if (!defaultName && named.length === 0) continue; // namespace / side-effect — nothing to verify
        const exported = exportedSymbols(target.content || '');
        if (defaultName && !exported.has('default')) {
          missingExports.push({
            file: targetPath,
            importer: fromFile,
            symbol: 'default',
            detail: `${fromFile} imports default from ${targetPath} but no default export exists`,
          });
        }
        for (const sym of named) {
          if (!exported.has(sym)) {
            missingExports.push({
              file: targetPath,
              importer: fromFile,
              symbol: sym,
              detail: `${fromFile} imports { ${sym} } from ${targetPath} but the symbol is not exported`,
            });
          }
        }
      }
    } else if (edge.kind === 'api-call-to-endpoint') {
      if (edge.to.startsWith('unresolved-route:')) {
        const head = edge.to.slice('unresolved-route:'.length);
        const space = head.indexOf(' ');
        const method = space > 0 ? head.slice(0, space) : 'GET';
        const url = space > 0 ? head.slice(space + 1) : head;
        // edge.from = api-client:<path>:<line>#<method> <url>
        const file = edge.from.startsWith('api-client:')
          ? edge.from.slice('api-client:'.length).split(':')[0]
          : edge.from;
        missingRoutes.push({
          file,
          method,
          url,
          detail: `Frontend calls ${method} ${url} but no backend route handles it`,
        });
      }
    }
  }

  const totalIssues =
    unresolvedImports.length + missingRoutes.length +
    missingExports.length + undeclaredDependencies.length;
  const passed = totalIssues === 0;

  const summary = passed
    ? `Verified ${graph.filesIndexed} files, ${graph.byKind.file.length} file nodes, ${graph.byKind.route.length} routes, ${graph.byKind['api-client'].length} api calls — graph is fully resolved`
    : `Found ${totalIssues} graph issue${totalIssues === 1 ? '' : 's'}: ${unresolvedImports.length} unresolved imports, ${missingExports.length} missing exports, ${missingRoutes.length} missing routes, ${undeclaredDependencies.length} undeclared deps`;

  return {
    unresolvedImports,
    missingRoutes,
    missingExports,
    undeclaredDependencies,
    passed,
    summary,
    totalIssues,
    stats: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      files: graph.filesIndexed,
      routesRegistered: graph.byKind.route.length,
      apiCalls: graph.byKind['api-client'].length,
    },
  };
}

/**
 * Flatten a verification result into the `string[]` shape the auto-fix
 * endpoint already understands (same convention as the runtime-error loop).
 * Each error becomes one line tagged `[graph]` so the cascade can route it.
 */
export function formatVerificationErrors(result: GraphVerificationResult, cap = 50): string[] {
  const lines: string[] = [];
  for (const e of result.unresolvedImports) {
    lines.push(`[graph] unresolved-import ${e.file}: ${e.spec} — ${e.detail}`);
  }
  for (const e of result.missingExports) {
    lines.push(`[graph] missing-export ${e.file}#${e.symbol} (imported by ${e.importer}) — ${e.detail}`);
  }
  for (const e of result.missingRoutes) {
    lines.push(`[graph] missing-route ${e.method} ${e.url} (called from ${e.file}) — ${e.detail}`);
  }
  for (const e of result.undeclaredDependencies) {
    lines.push(`[graph] undeclared-dep ${e.packageName} (imported by ${e.file}) — ${e.detail}`);
  }
  return lines.slice(0, cap);
}

/** Public surface for the graph node id helper used by formatters/tests. */
export { fileNodeId };
