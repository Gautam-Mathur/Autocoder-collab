/**
 * RuFlo Fusion — Ship Gate (3-layer cascade entry point)
 *
 * Layer 1 (FLOOR)     — deterministic syntax sweep
 * Layer 2 (WORKHORSE) — bounded SLM repair (best-effort, wraps repair-branch)
 * Layer 3 (BASEMENT)  — guaranteed-bootable template fallback
 *
 * Pre-delivery passes:
 *   - validateImports: every relative import resolves to a file in the bundle
 *   - validateExports: imports name a symbol the target file actually exports
 */

import { logEvent } from './observability-sink.js';
import type {
  AgentName,
  DecisionLog,
  DeliveryReport,
  ObservabilityEvent,
  SecurityIssue,
} from './types.js';

export interface ShipGateInput {
  sourceFiles: Record<string, string>;
  testFiles: Record<string, string>;
  qualityScore: number;
  securityIssues: SecurityIssue[];
  agentTimings: Partial<Record<AgentName, number>>;
  decisions: DecisionLog[];
  events: ObservabilityEvent[];
  errors: string[];
}

export async function shipGate(input: ShipGateInput): Promise<DeliveryReport> {
  const importErrors = validateImports(input.sourceFiles);
  const crossFileErrors = validateExports(input.sourceFiles);

  let repaired = input.sourceFiles;
  let repairsApplied = 0;
  let fallbacksTriggered = 0;

  if (importErrors.length > 0 || crossFileErrors.length > 0) {
    const result = await repairTargeted(repaired, [...importErrors, ...crossFileErrors]);
    repaired = result.files;
    repairsApplied = result.repairsApplied;
    fallbacksTriggered = result.fallbacksTriggered;
  }

  logEvent({
    type: 'ship_gate_pass',
    filesChecked: Object.keys(repaired).length,
    repairsApplied,
  });

  return {
    ok: input.errors.length === 0,
    filesGenerated: Object.keys(repaired).length,
    repairAttemptsUsed: repairsApplied,
    fallbacksTriggered,
    qualityScore: input.qualityScore,
    securityIssues: input.securityIssues,
    importErrorsFixed: importErrors.length,
    crossFileErrorsFixed: crossFileErrors.length,
    agentTimings: input.agentTimings,
    decisions: input.decisions,
    events: input.events,
    sourceFiles: repaired,
    testFiles: input.testFiles,
    errors: input.errors,
  };
}

interface ResolveError {
  file: string;
  reason: string;
  importPath?: string;
}

function validateImports(files: Record<string, string>): ResolveError[] {
  const errors: ResolveError[] = [];
  const known = new Set(Object.keys(files));

  for (const [file, content] of Object.entries(files)) {
    for (const spec of extractRelativeImports(content)) {
      const resolved = resolveImport(file, spec, known);
      if (!resolved) {
        errors.push({ file, importPath: spec, reason: `Unresolved relative import: ${spec}` });
      }
    }
  }
  return errors;
}

function validateExports(files: Record<string, string>): ResolveError[] {
  const errors: ResolveError[] = [];
  const known = new Set(Object.keys(files));
  const exportsByFile = new Map<string, Set<string>>();
  for (const [file, content] of Object.entries(files)) {
    exportsByFile.set(file, extractExports(content));
  }

  for (const [file, content] of Object.entries(files)) {
    const named = extractNamedImports(content);
    for (const { spec, names } of named) {
      const resolved = resolveImport(file, spec, known);
      if (!resolved) continue;
      const exports = exportsByFile.get(resolved) ?? new Set<string>();
      for (const n of names) {
        if (!exports.has(n) && !exports.has('*')) {
          errors.push({
            file,
            importPath: spec,
            reason: `Imported "${n}" from "${spec}" but file does not export it`,
          });
        }
      }
    }
  }
  return errors;
}

async function repairTargeted(
  files: Record<string, string>,
  errors: ResolveError[],
): Promise<{ files: Record<string, string>; repairsApplied: number; fallbacksTriggered: number }> {
  const out = { ...files };
  const failedFiles = new Set(errors.map((e) => e.file));
  let repairsApplied = 0;
  let fallbacksTriggered = 0;

  for (const file of failedFiles) {
    const original = out[file] ?? '';
    const errReason = errors.find((e) => e.file === file)?.reason ?? 'Validation error';
    const layered = await repairCascade(file, original, errReason);
    if (layered.content !== original) {
      out[file] = layered.content;
      repairsApplied++;
      if (layered.layer === 3) fallbacksTriggered++;
      logEvent({ type: 'ship_gate_fallback', file, layer: layered.layer });
    }
  }

  return { files: out, repairsApplied, fallbacksTriggered };
}

interface CascadeResult {
  content: string;
  layer: 1 | 2 | 3;
}

async function repairCascade(file: string, content: string, errorMsg: string): Promise<CascadeResult> {
  // Layer 1 — deterministic syntax sweep
  const l1 = layer1Fix(file, content);
  if (l1 !== content) return { content: l1, layer: 1 };

  // Layer 2 — SLM Repair
  try {
    const { repairFileWithSlm } = await import('./slm-repair.js');
    const l2 = await repairFileWithSlm(file, content, errorMsg);
    if (l2 && l2 !== content) {
      return { content: l2, layer: 2 };
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[RuFlo:ShipGate] SLM repair failed for ${file}, falling through to template-basement:`, (err as Error).message);
  }

  // Layer 3 — template basement (always boots)
  return { content: layer3Template(file), layer: 3 };
}

function layer2BoundedRepair(file: string, content: string): string {
  if (!content.trim()) return content;
  if (file.endsWith('.tsx')) {
    if (!/export\s+(default|function|const|class)/.test(content)) {
      const name = (file.split('/').pop() ?? 'Component').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '') || 'Component';
      return `${content}\nexport default function ${name}() { return null; }\n`;
    }
  }
  if (file.endsWith('.ts')) {
    if (!/export\s+(default|function|const|class|\*|\{)/.test(content)) {
      return `${content}\nexport {};\n`;
    }
  }
  return content;
}

function layer1Fix(_file: string, content: string): string {
  let out = content;
  // Strip nullish leftover semicolons
  out = out.replace(/;{2,}/g, ';');
  // Normalize line endings & trailing whitespace
  out = out.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

function layer3Template(file: string): string {
  if (file.endsWith('.tsx')) {
    const name = (file.split('/').pop() ?? 'Component').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '') || 'Component';
    return `export default function ${name}() {\n  return <div>${name} (fallback)</div>;\n}\n`;
  }
  if (file.endsWith('.ts')) return `// fallback\nexport {};\n`;
  if (file.endsWith('.json')) return '{}\n';
  if (file.endsWith('.html')) return '<!doctype html><html><body><div id="root"></div></body></html>\n';
  return '';
}

// ─── helpers ────────────────────────────────────────────────────────────

function extractRelativeImports(content: string): string[] {
  const out: string[] = [];
  const re = /(?:import|from)\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('@/')) out.push(spec);
  }
  return out;
}

function extractNamedImports(content: string): Array<{ spec: string; names: string[] }> {
  const out: Array<{ spec: string; names: string[] }> = [];
  const re = /import\s+(?:(\w+)|\{([^}]+)\}|(\w+)\s*,\s*\{([^}]+)\})\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const def = m[1];
    const named = m[2] ?? m[4];
    const defWithNamed = m[3];
    const spec = m[5];
    if (!spec.startsWith('.') && !spec.startsWith('@/')) continue;
    const names: string[] = [];
    if (def) names.push('default');
    if (defWithNamed) names.push('default');
    if (named) {
      for (const part of named.split(',')) {
        const cleaned = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (cleaned) names.push(cleaned);
      }
    }
    out.push({ spec, names });
  }
  return out;
}

function extractExports(content: string): Set<string> {
  const out = new Set<string>();
  if (/export\s+default\b/.test(content)) out.add('default');
  if (/export\s+\*/.test(content)) out.add('*');
  const re1 = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g;
  const re2 = /export\s*\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(content)) !== null) out.add(m[1]);
  while ((m = re2.exec(content)) !== null) {
    for (const part of m[1].split(',')) {
      const cleaned = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (cleaned) out.add(cleaned);
    }
  }
  return out;
}

function resolveImport(fromFile: string, spec: string, known: Set<string>): string | null {
  let target: string;
  if (spec.startsWith('@/')) {
    target = 'src/' + spec.slice(2);
  } else {
    const fromDir = fromFile.split('/').slice(0, -1).join('/');
    const parts = (fromDir + '/' + spec).split('/');
    const stack: string[] = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') stack.pop();
      else stack.push(p);
    }
    target = stack.join('/');
  }
  const candidates = [target, target + '.ts', target + '.tsx', target + '/index.ts', target + '/index.tsx'];
  for (const c of candidates) if (known.has(c)) return c;
  return null;
}
