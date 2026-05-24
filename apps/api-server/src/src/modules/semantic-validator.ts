/**
 * Semantic Coherence Validator (Task #22).
 *
 * Operates on the Task #18 ProjectGraph + the raw file contents to surface
 * five classes of architectural defects that the graph verifier (Task #18)
 * does NOT catch — those check that imports/exports/routes resolve, this one
 * checks that the resolved structure is *coherent*.
 *
 * Categories:
 *   1. orphan-state         — `useState`/`useReducer` value is never read.
 *   2. dead-route           — backend route has no frontend consumer.
 *   3. duplicate-ownership  — same provider wrapper mounted in 2+ files.
 *   4. circular-ui          — cycle in component import graph.
 *   5. impossible-data-flow — frontend api call URL+method has no matching
 *                             backend route (with helpful repair hint when
 *                             the URL exists under a different method or a
 *                             different shape).
 *
 * Pure: no I/O, no module-level state, bounded by `MAX_FILES_SCANNED`. Safe
 * to call multiple times. Returns a `SemanticValidationResult` even on an
 * empty graph; never throws.
 *
 * Severity model:
 *   - `block` defects feed the auto-fix loop with `errorType: 'semantic'`.
 *   - `warn`  defects only surface in the UI / OrchestrationResult.
 *
 * The `formatSemanticErrors(result)` helper renders defects into the same
 * tagged string shape the graph cascade uses (`[semantic] ...`), so the
 * existing `parseErrors` / `analyzeAndFix` pipeline can consume them.
 */

import type {
  ProjectGraph,
  GraphFile,
  GraphNode,
  GraphEdge,
} from './project-graph/graph-builder.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type SemanticDefectCategory =
  | 'orphan-state'
  | 'dead-route'
  | 'duplicate-ownership'
  | 'circular-ui'
  | 'impossible-data-flow';

export type SemanticDefectSeverity = 'block' | 'warn';

export interface SemanticDefect {
  category: SemanticDefectCategory;
  severity: SemanticDefectSeverity;
  /** Primary file the defect lives in. */
  file: string;
  /** 1-based line, when known. */
  line?: number;
  /** Symbol/route/node name involved. */
  node?: string;
  /** Other files that participate in the defect (e.g. cycle members). */
  relatedFiles?: string[];
  /** Human-readable explanation for the chat UI (task contract: humanReason). */
  humanReason: string;
  /** Suggested repair the auto-fix loop can hand to the SLM/template tier
   *  (task contract: repairHint). */
  repairHint: string;
}

export interface SemanticValidationStats {
  filesScanned: number;
  componentsScanned: number;
  routesScanned: number;
  apiCallsScanned: number;
}

export interface SemanticValidationResult {
  defects: SemanticDefect[];
  blocking: SemanticDefect[];
  warnings: SemanticDefect[];
  /** True when no `block`-severity defect is present. `warn`s do not flip this. */
  passed: boolean;
  summary: string;
  stats: SemanticValidationStats;
  byCategory: Record<SemanticDefectCategory, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Limits — keep bounded so a giant project can't make the validator hang.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_FILES_SCANNED = 800;
const MAX_DEFECTS = 200;

// Provider components whose duplication usually breaks the app at runtime.
// Conservative on purpose — false positives here cost more than misses.
const SINGLETON_PROVIDERS = new Set<string>([
  'QueryClientProvider',
  'BrowserRouter',
  'HashRouter',
  'MemoryRouter',
  'Router',
  'Provider', // redux
  'ReduxProvider',
  'AuthProvider',
  'ThemeProvider',
  'HelmetProvider',
  'TooltipProvider',
  'I18nextProvider',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export function validateSemantics(
  graph: ProjectGraph,
  files: GraphFile[],
): SemanticValidationResult {
  const stats: SemanticValidationStats = {
    filesScanned: 0,
    componentsScanned: graph.byKind.component.length,
    routesScanned: graph.byKind.route.length,
    apiCallsScanned: graph.byKind['api-client'].length,
  };

  const defects: SemanticDefect[] = [];
  const push = (d: SemanticDefect): boolean => {
    if (defects.length >= MAX_DEFECTS) return false;
    defects.push(d);
    return true;
  };

  const scanFiles = files.slice(0, MAX_FILES_SCANNED);
  stats.filesScanned = scanFiles.length;
  const byPath = new Map<string, GraphFile>();
  for (const f of scanFiles) byPath.set(f.path, f);

  try { findOrphanState(scanFiles, push); } catch { /* never block */ }
  try { findDeadRoutes(graph, push); } catch { /* never block */ }
  try { findDuplicateOwnership(scanFiles, push); } catch { /* never block */ }
  try { findCircularUI(graph, byPath, push); } catch { /* never block */ }
  try { findImpossibleDataFlows(graph, push); } catch { /* never block */ }
  try { findShapeMismatches(graph, scanFiles, push); } catch { /* never block */ }

  const blocking = defects.filter(d => d.severity === 'block');
  const warnings = defects.filter(d => d.severity === 'warn');
  const byCategory: Record<SemanticDefectCategory, number> = {
    'orphan-state': 0,
    'dead-route': 0,
    'duplicate-ownership': 0,
    'circular-ui': 0,
    'impossible-data-flow': 0,
  };
  for (const d of defects) byCategory[d.category]++;

  const summary = defects.length === 0
    ? `Semantic check passed across ${stats.filesScanned} files, ${stats.componentsScanned} components, ${stats.routesScanned} routes, ${stats.apiCallsScanned} api calls.`
    : `${defects.length} semantic defect(s): ${blocking.length} blocking, ${warnings.length} warning. ` +
      Object.entries(byCategory).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(', ');

  return {
    defects,
    blocking,
    warnings,
    passed: blocking.length === 0,
    summary,
    stats,
    byCategory,
  };
}

/**
 * Render defects into the tagged string shape used by the auto-fix loop:
 *   `[semantic] <category> <file>[:<line>] — <humanReason> | hint: <repairHint>`
 *
 * Used both for the auto-fix request (parsed by vite-error-fixer's
 * parseErrors via the repair-pipeline) and for the friendly chat step.
 */
export function formatSemanticErrors(result: SemanticValidationResult): string[] {
  return result.defects.map(d => {
    const loc = d.line ? `:${d.line}` : '';
    return `[semantic] ${d.category} ${d.file}${loc} — ${d.humanReason} | hint: ${d.repairHint}`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. orphan-state
//
// Detect `const [x, setX] = useState(…)` (and useReducer) where neither `x`
// nor `setX` is referenced again in the same file body. Regex-based to match
// the rest of the project-graph stack (no AST). Skips the binding line itself
// and string/comment noise via a coarse strip.
// ─────────────────────────────────────────────────────────────────────────────
function findOrphanState(files: GraphFile[], push: (d: SemanticDefect) => boolean): void {
  const HOOK_RE = /const\s+\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*(useState|useReducer)\b/g;
  for (const f of files) {
    if (!isComponentLikeFile(f.path)) continue;
    if (!f.content || f.content.length > 200_000) continue;
    const stripped = stripStringsAndComments(f.content);
    let m: RegExpExecArray | null;
    HOOK_RE.lastIndex = 0;
    while ((m = HOOK_RE.exec(stripped)) !== null) {
      const value = m[1];
      const setter = m[2];
      const hookName = m[3];
      // Build a regex that finds either identifier outside the binding line.
      // Use word boundary; allow .props / call / JSX usage.
      const usageRe = new RegExp(`\\b(${escapeRe(value)}|${escapeRe(setter)})\\b`, 'g');
      const matches = stripped.match(usageRe) || [];
      // Each binding contributes 2 references (the destructured names
      // themselves) — anything more means the value is read or set.
      if (matches.length <= 2) {
        const line = lineOfOffset(f.content, m.index);
        if (!push({
          category: 'orphan-state',
          severity: 'warn',
          file: f.path,
          line,
          node: value,
          humanReason: `${hookName}() result \`${value}\` / \`${setter}\` is declared but never read or set elsewhere in the file.`,
          repairHint: `Remove the unused ${hookName} binding on line ${line}, or wire \`${value}\`/\`${setter}\` into the JSX/handlers that should drive it.`,
        })) return;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. dead-route
//
// A backend route node with NO incoming `api-call-to-endpoint` edge. Skips
// well-known operational routes (health, metrics) where no FE consumer is
// expected.
// ─────────────────────────────────────────────────────────────────────────────
const OPERATIONAL_ROUTE_RE = /^(\/api)?\/(?:healthz?|status|metrics|ready|live|favicon\.ico|robots\.txt)\b/i;
function findDeadRoutes(graph: ProjectGraph, push: (d: SemanticDefect) => boolean): void {
  const consumed = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind === 'api-call-to-endpoint' && !e.to.startsWith('unresolved-route:')) {
      consumed.add(e.to);
    }
  }
  for (const route of graph.byKind.route) {
    if (consumed.has(route.id)) continue;
    if (OPERATIONAL_ROUTE_RE.test(route.name)) continue;
    if (!push({
      category: 'dead-route',
      severity: 'warn',
      file: route.file,
      line: route.line,
      node: `${route.method} ${route.name}`,
      humanReason: `Backend route \`${route.method} ${route.name}\` has no frontend caller — nothing in the app ever fetches it.`,
      repairHint: `Either delete the handler in ${route.file} or add a frontend api call (e.g. \`fetch('${route.name}', { method: '${route.method}' })\`) from the relevant page/hook.`,
    })) return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. duplicate-ownership
//
// Same singleton provider mounted in 2+ files. Most apps need exactly one
// `<QueryClientProvider>` / `<BrowserRouter>` / etc. Two copies (a common
// LLM artefact when the generator emits both `main.tsx` and `App.tsx` with
// the same wrapper) breaks routing or context lookup at runtime.
// ─────────────────────────────────────────────────────────────────────────────
function findDuplicateOwnership(files: GraphFile[], push: (d: SemanticDefect) => boolean): void {
  // provider name → list of { file, line }
  const occurrences = new Map<string, { file: string; line: number }[]>();
  for (const f of files) {
    if (!isComponentLikeFile(f.path)) continue;
    if (!f.content || f.content.length > 200_000) continue;
    const stripped = stripStringsAndComments(f.content);
    for (const provider of SINGLETON_PROVIDERS) {
      const re = new RegExp(`<\\s*${escapeRe(provider)}\\b`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripped)) !== null) {
        const list = occurrences.get(provider) || [];
        list.push({ file: f.path, line: lineOfOffset(f.content, m.index) });
        occurrences.set(provider, list);
        // One occurrence per file is enough to surface duplication.
        break;
      }
    }
  }
  for (const [provider, locs] of occurrences) {
    if (locs.length < 2) continue;
    const [primary, ...rest] = locs;
    if (!push({
      category: 'duplicate-ownership',
      severity: 'block',
      file: primary.file,
      line: primary.line,
      node: provider,
      relatedFiles: rest.map(r => r.file),
      humanReason: `<${provider}> is mounted in ${locs.length} files (${locs.map(l => l.file).join(', ')}). Singleton providers must wrap the app exactly once or downstream context lookups break.`,
      repairHint: `Keep the outermost <${provider}> (typically src/main.tsx) and remove the duplicate(s) in: ${rest.map(r => r.file).join(', ')}.`,
    })) return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. circular-ui
//
// Detect cycles in the file→file import graph restricted to files that
// declare components/hooks (i.e. UI cycles, not utility cycles which TS can
// usually handle). Uses iterative DFS with a recursion-stack to catch
// back-edges; reports each cycle once.
// ─────────────────────────────────────────────────────────────────────────────
function findCircularUI(
  graph: ProjectGraph,
  byPath: Map<string, GraphFile>,
  push: (d: SemanticDefect) => boolean,
): void {
  // Build adjacency: file path → file paths it imports (UI files only).
  const uiFiles = new Set<string>();
  for (const n of graph.byKind.component) uiFiles.add(n.file);
  for (const n of graph.byKind.hook) uiFiles.add(n.file);
  if (uiFiles.size === 0) return;

  const adj = new Map<string, string[]>();
  for (const f of uiFiles) adj.set(f, []);
  for (const e of graph.edges) {
    if (e.kind !== 'import') continue;
    if (!e.from.startsWith('file:') || !e.to.startsWith('file:')) continue;
    const from = e.from.slice('file:'.length);
    const to = e.to.slice('file:'.length);
    if (!uiFiles.has(from) || !uiFiles.has(to)) continue;
    if (from === to) continue; // self-import ignored
    adj.get(from)!.push(to);
  }

  const seenCycles = new Set<string>();
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const f of uiFiles) color.set(f, WHITE);

  for (const start of uiFiles) {
    if (color.get(start) !== WHITE) continue;
    // Iterative DFS with explicit parent stack so we can recover the cycle.
    const stack: { node: string; iter: number }[] = [{ node: start, iter: 0 }];
    const path: string[] = [];
    color.set(start, GRAY);
    path.push(start);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const neighbors = adj.get(top.node) || [];
      if (top.iter >= neighbors.length) {
        color.set(top.node, BLACK);
        stack.pop();
        path.pop();
        continue;
      }
      const next = neighbors[top.iter++];
      const c = color.get(next);
      if (c === GRAY) {
        // Cycle: extract from `path` starting at first occurrence of `next`.
        const cutIdx = path.indexOf(next);
        if (cutIdx >= 0) {
          const cycle = path.slice(cutIdx).concat(next);
          const key = [...cycle].sort().join('|');
          if (!seenCycles.has(key)) {
            seenCycles.add(key);
            const [head, ...rest] = cycle;
            if (!push({
              category: 'circular-ui',
              severity: 'block',
              file: head,
              relatedFiles: rest,
              node: head,
              humanReason: `Circular component import detected: ${cycle.join(' → ')}. React renders one of these files before the other is defined, producing an undefined component at runtime.`,
              repairHint: `Break the cycle by hoisting the shared piece into a third file (e.g. a types/utils module) and importing FROM that third file in both ${head} and ${rest[0] || cycle[1]}.`,
            })) return;
          }
        }
      } else if (c === WHITE) {
        color.set(next, GRAY);
        path.push(next);
        stack.push({ node: next, iter: 0 });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. impossible-data-flow
//
// Frontend api-call edges whose target is `unresolved-route:METHOD URL`
// AND a route exists for the same URL under a different method (so the FE
// is calling the wrong verb), OR the URL is shaped like an API but no route
// matches at all — but ONLY when the backend has at least one route (so a
// pure-frontend prototype isn't penalised).
// ─────────────────────────────────────────────────────────────────────────────
function findImpossibleDataFlows(graph: ProjectGraph, push: (d: SemanticDefect) => boolean): void {
  if (graph.byKind.route.length === 0) return;
  const apiNodesById = new Map<string, GraphNode>();
  for (const n of graph.byKind['api-client']) apiNodesById.set(n.id, n);

  for (const e of graph.edges) {
    if (e.kind !== 'api-call-to-endpoint') continue;
    if (!e.to.startsWith('unresolved-route:')) continue;
    const callNode = apiNodesById.get(e.from);
    if (!callNode || !callNode.method || !callNode.name) continue;
    // Skip non-API URLs (external, anchors, assets).
    if (!callNode.name.startsWith('/')) continue;

    // Find a route with the SAME path under a different method.
    const sameUrl = graph.byKind.route.find(r => normalizePath(r.name) === normalizePath(callNode.name));
    if (sameUrl) {
      if (!push({
        category: 'impossible-data-flow',
        severity: 'block',
        file: callNode.file,
        line: callNode.line,
        node: `${callNode.method} ${callNode.name}`,
        relatedFiles: [sameUrl.file],
        humanReason: `Frontend calls \`${callNode.method} ${callNode.name}\` but the backend only exposes \`${sameUrl.method} ${sameUrl.name}\` (in ${sameUrl.file}). The wrong HTTP verb is used.`,
        repairHint: `Change the frontend call in ${callNode.file}:${callNode.line ?? '?'} to method \`${sameUrl.method}\`, OR add a \`${callNode.method}\` handler for ${callNode.name} in ${sameUrl.file}.`,
      })) return;
      continue;
    }
    // No matching path at all — only flag when the call clearly targets the
    // backend (`/api/…`) so we don't false-positive on static asset hrefs.
    if (callNode.name.startsWith('/api/')) {
      if (!push({
        category: 'impossible-data-flow',
        severity: 'block',
        file: callNode.file,
        line: callNode.line,
        node: `${callNode.method} ${callNode.name}`,
        humanReason: `Frontend calls \`${callNode.method} ${callNode.name}\` but no backend route is registered for that URL.`,
        repairHint: `Either add an Express route (\`router.${callNode.method.toLowerCase()}('${callNode.name}', …)\`) on the API server, or update the frontend call in ${callNode.file}:${callNode.line ?? '?'} to a URL that exists.`,
      })) return;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b. impossible-data-flow — request/response shape coherence
//
// In addition to URL/method matching (above), we check that the request body
// the frontend sends and the response it reads roughly align with what the
// route handler accepts/returns. Two directions:
//
//   - request-shape: route handler reads `req.body.X` but the frontend call
//     for that route never includes `X` in its inline body literal.
//   - response-shape: route handler returns `res.json({a, b})` but the FE
//     consumer reads `data.X` for some X not in the literal.
//
// Both checks are intentionally narrow: they only fire when the route's
// handler contains a single inline literal and the FE's call contains a
// single inline body literal (or a single awaited assignment). False
// positives here would be very expensive, so we skip rather than guess.
// ─────────────────────────────────────────────────────────────────────────────
function findShapeMismatches(
  graph: ProjectGraph,
  files: GraphFile[],
  push: (d: SemanticDefect) => boolean,
): void {
  if (graph.byKind.route.length === 0) return;
  const byPath = new Map<string, GraphFile>();
  for (const f of files) byPath.set(f.path, f);

  // Index route handlers by id so we can look up their file content.
  for (const route of graph.byKind.route) {
    const routeFile = byPath.get(route.file);
    if (!routeFile || !routeFile.content) continue;
    const handlerSlice = sliceHandlerBody(routeFile.content, route.line ?? 1);
    if (!handlerSlice) continue;
    const reqBodyFields = extractReqBodyFields(handlerSlice);
    const resJsonFields = extractResJsonFields(handlerSlice);

    // Find FE callers of this route via api-call-to-endpoint edges.
    const callerEdges = graph.edges.filter(e => e.kind === 'api-call-to-endpoint' && e.to === route.id);
    for (const ce of callerEdges) {
      const callNode = graph.byKind['api-client'].find(n => n.id === ce.from);
      if (!callNode) continue;
      const callerFile = byPath.get(callNode.file);
      if (!callerFile || !callerFile.content || callNode.line == null) continue;
      const callSlice = sliceCallExpression(callerFile.content, callNode.line);
      if (!callSlice) continue;

      // Request-shape mismatch
      if (reqBodyFields.size > 0) {
        const sentFields = extractSentBodyFields(callSlice);
        if (sentFields !== null) {
          const missing = [...reqBodyFields].filter(f => !sentFields.has(f));
          if (missing.length > 0) {
            if (!push({
              category: 'impossible-data-flow',
              severity: 'block',
              file: callNode.file,
              line: callNode.line,
              node: `${callNode.method} ${callNode.name}`,
              relatedFiles: [route.file],
              humanReason: `Frontend call to \`${callNode.method} ${callNode.name}\` omits field(s) [${missing.join(', ')}] that the backend handler in ${route.file} reads from \`req.body\`.`,
              repairHint: `Add the missing field(s) [${missing.join(', ')}] to the request body in ${callNode.file}:${callNode.line}, or stop reading them in ${route.file}.`,
            })) return;
          }
        }
      }

      // Response-shape mismatch (read ahead a few lines after the call for
      // `data.X` / `result.X` / `response.X` accesses on the awaited value).
      if (resJsonFields.size > 0) {
        const readFields = extractReadResponseFields(callerFile.content, callNode.line);
        const phantom = [...readFields].filter(f => !resJsonFields.has(f));
        if (phantom.length > 0) {
          if (!push({
            category: 'impossible-data-flow',
            severity: 'block',
            file: callNode.file,
            line: callNode.line,
            node: `${callNode.method} ${callNode.name}`,
            relatedFiles: [route.file],
            humanReason: `Frontend reads field(s) [${phantom.join(', ')}] from the response of \`${callNode.method} ${callNode.name}\`, but the backend handler in ${route.file} only returns [${[...resJsonFields].join(', ')}].`,
            repairHint: `Either stop reading [${phantom.join(', ')}] in ${callNode.file}:${callNode.line}, or include those field(s) in the \`res.json({…})\` call in ${route.file}.`,
          })) return;
        }
      }
    }
  }
}

/** Coarse handler-body slice: from the route's line to the matching `}`. */
function sliceHandlerBody(content: string, startLine: number): string | null {
  const lines = content.split('\n');
  if (startLine < 1 || startLine > lines.length) return null;
  // Find first `{` on/after startLine, then walk braces.
  let depth = 0;
  let started = false;
  const collected: string[] = [];
  for (let i = startLine - 1; i < lines.length && i < startLine + 200; i++) {
    const line = lines[i];
    collected.push(line);
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}' && started) {
        depth--;
        if (depth === 0) return collected.join('\n');
      }
    }
  }
  return started ? collected.join('\n') : null;
}

function extractReqBodyFields(handler: string): Set<string> {
  const out = new Set<string>();
  const stripped = stripStringsAndComments(handler);
  // Direct member access: req.body.X
  const memberRe = /\breq\.body\.([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(stripped)) !== null) out.add(m[1]);
  // Destructure: const { a, b } = req.body
  const destrRe = /(?:const|let|var)\s*\{\s*([^}]+)\s*\}\s*=\s*req\.body\b/g;
  while ((m = destrRe.exec(stripped)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[:=]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return out;
}

function extractResJsonFields(handler: string): Set<string> {
  const out = new Set<string>();
  const stripped = stripStringsAndComments(handler);
  // res.json({ a: ..., b: ... })  — only the first inline literal is parsed.
  const re = /\bres\.(?:json|status\(\s*\d+\s*\)\.json)\s*\(\s*\{([^{}]*)\}\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return out;
}

/** Slice the `fetch(...)` / `apiRequest(...)` call expression by brace count. */
function sliceCallExpression(content: string, startLine: number): string | null {
  const lines = content.split('\n');
  if (startLine < 1 || startLine > lines.length) return null;
  let depth = 0;
  let started = false;
  const collected: string[] = [];
  for (let i = startLine - 1; i < lines.length && i < startLine + 30; i++) {
    const line = lines[i];
    collected.push(line);
    for (const ch of line) {
      if (ch === '(') { depth++; started = true; }
      else if (ch === ')' && started) {
        depth--;
        if (depth === 0) return collected.join('\n');
      }
    }
  }
  return started ? collected.join('\n') : null;
}

function extractSentBodyFields(call: string): Set<string> | null {
  const stripped = stripStringsAndComments(call);
  // Look for body: JSON.stringify({ a, b }) OR body: { a, b } OR
  // apiRequest("POST", "/x", { a, b })
  const bodyJson = stripped.match(/body\s*:\s*JSON\.stringify\s*\(\s*\{([^{}]*)\}\s*\)/);
  const bodyObj = stripped.match(/body\s*:\s*\{([^{}]*)\}/);
  const apiArg = stripped.match(/apiRequest\s*\([^)]*?,\s*\{([^{}]*)\}\s*\)/);
  const inner = bodyJson?.[1] ?? bodyObj?.[1] ?? apiArg?.[1];
  if (inner == null) return null; // unknown shape — skip rather than false-positive
  const out = new Set<string>();
  for (const part of inner.split(',')) {
    const name = part.trim().split(/[:=]/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
  }
  return out;
}

function extractReadResponseFields(content: string, callLine: number): Set<string> {
  const out = new Set<string>();
  const lines = content.split('\n');
  const window = lines.slice(callLine - 1, Math.min(lines.length, callLine + 40)).join('\n');
  const stripped = stripStringsAndComments(window);
  for (const ident of ['data', 'result', 'response', 'json', 'res']) {
    const re = new RegExp(`\\b${ident}\\.([A-Za-z_$][\\w$]*)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const f = m[1];
      // Skip well-known client API surface (axios/fetch internals).
      if (['then', 'catch', 'finally', 'json', 'text', 'ok', 'status', 'statusText', 'headers', 'body', 'data'].includes(f)) continue;
      out.add(f);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function isComponentLikeFile(p: string): boolean {
  return /\.(?:tsx|jsx)$/i.test(p) || /\.(?:ts|js)$/i.test(p) && /\/(components|pages|hooks|src)\//i.test(p);
}

function escapeRe(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

function normalizePath(p: string): string {
  return p.replace(/\?.*$/, '').replace(/\$\{[^}]+\}/g, ':param').replace(/:[^/]+/g, ':param').replace(/\/+$/, '');
}

/**
 * Coarse strip of strings, template literals, and comments so identifier
 * regexes don't false-match inside string content. Keeps line breaks so
 * `lineOfOffset` results stay correct.
 */
function stripStringsAndComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    // Line comment
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    // String literal (single/double/backtick) — drop content but preserve newlines
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch; i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += quote; i++; }
      continue;
    }
    out += ch; i++;
  }
  return out;
}

// Re-export graph types for callers that only import the validator.
export type { ProjectGraph, GraphFile, GraphNode, GraphEdge };
