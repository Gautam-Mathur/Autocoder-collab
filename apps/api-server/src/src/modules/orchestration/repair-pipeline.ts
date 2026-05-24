/**
 * Orchestration — Repair Pipeline (Task #18 split).
 *
 * Funnels repair work into one place. Layers, in priority order:
 *   1. parser-gate     — Babel / regex level fixes (vite-error-fixer)
 *   2. graph cascade   — Stage 14.5 errors flattened to `[graph] ...` lines
 *                        and routed through the same auto-fix endpoint as
 *                        runtime / build errors. Capped attempts mirror the
 *                        runtime-error loop.
 *
 * SLM repair and template-basement are owned by `continuous-debugger.ts` and
 * `pipeline-orchestrator.ts` and are not duplicated here; this module just
 * collects the entry points so external callers (routes) have one shape.
 */

import {
  parseErrors,
  analyzeAndFix,
  validateImportPaths,
  addDependenciesToPackageJson,
  fixTSGenericBracketMismatch,
} from '../vite-error-fixer.js';
import {
  formatVerificationErrors,
  type GraphVerificationResult,
} from '../project-graph/index.js';
import {
  formatSemanticErrors,
  type SemanticValidationResult,
  type SemanticDefect,
} from '../semantic-validator.js';

export type RepairErrorType = 'build' | 'runtime' | 'graph' | 'semantic' | 'unresolved-import';

export interface RepairRequest {
  errorMessages: string[];
  errorType: RepairErrorType;
  attempt: number;
  maxAttempts?: number;
}

export interface RepairAttemptDecision {
  shouldProceed: boolean;
  reason?: string;
  /** Normalized messages safe to feed into vite-error-fixer's `parseErrors`. */
  normalizedMessages: string[];
}

const DEFAULT_MAX_ATTEMPTS: Record<RepairErrorType, number> = {
  build: 5,
  runtime: 3,
  graph: 3,
  semantic: 2,
  'unresolved-import': 3,
};

/**
 * Decide whether a given auto-fix request should run, and normalize the
 * incoming error strings so all three error kinds can share one parser.
 */
export function evaluateRepair(req: RepairRequest): RepairAttemptDecision {
  const cap = req.maxAttempts ?? DEFAULT_MAX_ATTEMPTS[req.errorType];
  if (req.attempt > cap) {
    return {
      shouldProceed: false,
      reason: `${req.errorType}-error attempt cap reached (${cap})`,
      normalizedMessages: [],
    };
  }
  const normalizedMessages =
    req.errorType === 'graph'
      ? req.errorMessages.map(m => m.replace(/^\s*\[graph\]\s*/, ''))
      : req.errorType === 'semantic'
        ? req.errorMessages.map(m => m.replace(/^\s*\[semantic\]\s*/, ''))
        : req.errorType === 'unresolved-import'
          ? req.errorMessages.map(m => m.replace(/^\s*\[unresolved-import\]\s*/, ''))
          : req.errorMessages;
  return { shouldProceed: true, normalizedMessages };
}

/** Convert a Task #22 semantic-validation result to a RepairRequest. */
export function buildSemanticRepairRequest(
  result: SemanticValidationResult,
  attempt = 1,
): RepairRequest {
  return {
    errorMessages: formatSemanticErrors(result),
    errorType: 'semantic',
    attempt,
  };
}

/** Convert a Stage 14.5 result to the request shape the auto-fix loop wants. */
export function buildGraphRepairRequest(
  result: GraphVerificationResult,
  attempt = 1,
): RepairRequest {
  return {
    errorMessages: formatVerificationErrors(result),
    errorType: 'graph',
    attempt,
  };
}

export interface GraphRepairFile { path: string; content: string; language?: string; }
export interface GraphRepairOutcome {
  files: GraphRepairFile[];
  /** Number of files that were patched / created across this attempt. */
  fixesApplied: number;
  /** Packages added to package.json. */
  newDependencies: { name: string; version: string }[];
  /** Tag-stripped error messages that were actually fed to vite-error-fixer. */
  consumed: string[];
}

/**
 * Apply one repair pass on graph errors. Translates the structured errors
 * into the same string[] vite-error-fixer expects (with the [graph] tag
 * stripped) and applies the resulting fixes to the file set in-memory.
 *
 * This is the same path the /api/conversations/:id/auto-fix endpoint uses
 * for `errorType: 'graph'` requests, so behaviour stays in sync regardless of
 * whether the repair runs inside or outside the orchestrator.
 */
export function applyGraphRepair(
  files: GraphRepairFile[],
  verification: GraphVerificationResult,
): GraphRepairOutcome {
  const errorLines = formatVerificationErrors(verification);
  const consumed = errorLines.map(m => m.replace(/^\s*\[graph\]\s*/, ''));
  const parsed = parseErrors(consumed);
  const next = files.map(f => ({ ...f }));
  if (parsed.length === 0) {
    return { files: next, fixesApplied: 0, newDependencies: [], consumed };
  }

  const result = analyzeAndFix(parsed, next.map(f => ({
    path: f.path,
    content: f.content,
    language: f.language || (f.path.split('.').pop() || ''),
  })));

  let applied = 0;
  const newDependencies: { name: string; version: string }[] = [];
  for (const fix of result.fixes) {
    if (fix.type === 'add_dependency' && fix.packageName) {
      newDependencies.push({ name: fix.packageName, version: fix.packageVersion || 'latest' });
      applied++;
      continue;
    }
    if (fix.type === 'create_file') {
      next.push({
        path: fix.filePath,
        content: fix.newContent,
        language: fix.filePath.split('.').pop() || '',
      });
      applied++;
      continue;
    }
    if (fix.type === 'patch_file' || fix.type === 'fix_path') {
      const idx = next.findIndex(f => f.path === fix.filePath);
      if (idx >= 0 && fix.newContent && fix.newContent !== next[idx].content) {
        next[idx] = { ...next[idx], content: fix.newContent };
        applied++;
      }
    }
  }

  if (newDependencies.length > 0) {
    const pkgIdx = next.findIndex(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
    if (pkgIdx >= 0) {
      const updated = addDependenciesToPackageJson(next[pkgIdx].content, newDependencies);
      if (updated !== next[pkgIdx].content) {
        next[pkgIdx] = { ...next[pkgIdx], content: updated };
      }
    }
  }
  return { files: next, fixesApplied: applied, newDependencies, consumed };
}

/**
 * Apply one repair pass on Task #22 semantic defects. Mirrors
 * `applyGraphRepair`'s shape: structured defects → `[semantic]` strings →
 * vite-error-fixer. In addition, before delegating, we apply two pure
 * in-memory repairs that vite-error-fixer cannot do today:
 *
 *   - `orphan-state` (warn): remove the unused `useState`/`useReducer` line.
 *   - `duplicate-ownership` (block): remove the inner provider wrapper from
 *     every related file, keeping the primary occurrence.
 *
 * The remaining categories (dead-route, circular-ui, impossible-data-flow)
 * are too structural to auto-patch safely; they fall through to the standard
 * cascade (SLM repair / template basement) via the auto-fix endpoint.
 */
export interface SemanticRepairOutcome {
  files: GraphRepairFile[];
  fixesApplied: number;
  consumed: string[];
  remainingDefects: SemanticDefect[];
}

export function applySemanticRepair(
  files: GraphRepairFile[],
  result: SemanticValidationResult,
): SemanticRepairOutcome {
  const next = files.map(f => ({ ...f }));
  const consumed = formatSemanticErrors(result).map(m => m.replace(/^\s*\[semantic\]\s*/, ''));
  const remaining: SemanticDefect[] = [];
  let applied = 0;

  for (const defect of result.defects) {
    if (defect.category === 'orphan-state' && defect.line) {
      const idx = next.findIndex(f => f.path === defect.file);
      if (idx >= 0) {
        const lines = next[idx].content.split('\n');
        const target = lines[defect.line - 1] || '';
        if (/(useState|useReducer)\b/.test(target) && /const\s+\[/.test(target)) {
          lines.splice(defect.line - 1, 1);
          next[idx] = { ...next[idx], content: lines.join('\n') };
          applied++;
          continue;
        }
      }
      remaining.push(defect);
      continue;
    }

    if (defect.category === 'duplicate-ownership' && defect.node && defect.relatedFiles) {
      const provider = defect.node;
      // Remove `<Provider …> … </Provider>` wrapper from each related (non-primary)
      // file by collapsing to its inner contents. Hardened guards:
      //   - file must contain EXACTLY ONE open tag and EXACTLY ONE close tag
      //     (multiple instances → bail; cannot disambiguate without an AST)
      //   - close tag must come after open tag
      //   - the wrapper must contain at least one non-whitespace child
      // Self-closing `<Provider … />` is rejected (it's not a wrapper, just
      // an instance — a different defect class).
      const tagOpenRe = new RegExp(`<\\s*${escapeRegex(provider)}\\b[^>]*>`, 'g');
      const tagCloseRe = new RegExp(`<\\s*/\\s*${escapeRegex(provider)}\\s*>`, 'g');
      const tagSelfRe = new RegExp(`<\\s*${escapeRegex(provider)}\\b[^/>]*/>`, 'g');
      let anyDone = false;
      for (const path of defect.relatedFiles) {
        const idx = next.findIndex(f => f.path === path);
        if (idx < 0) continue;
        const content = next[idx].content;
        // Reject self-closing.
        tagSelfRe.lastIndex = 0;
        if (tagSelfRe.test(content)) continue;
        // Count occurrences — must be exactly one of each.
        const opens = matchAll(content, tagOpenRe);
        const closes = matchAll(content, tagCloseRe);
        if (opens.length !== 1 || closes.length !== 1) continue;
        const open = opens[0];
        const close = closes[0];
        if (close.index <= open.index) continue;
        const inner = content.slice(open.index + open.match.length, close.index);
        if (!inner.trim()) continue;
        const updated = content.slice(0, open.index) + inner + content.slice(close.index + close.match.length);
        if (updated !== content) {
          next[idx] = { ...next[idx], content: updated };
          applied++;
          anyDone = true;
        }
      }
      if (!anyDone) remaining.push(defect);
      continue;
    }

    // impossible-data-flow — handle the two structurally-fixable sub-cases:
    //   (a) wrong-method  : swap the FE call's method literal to the verb
    //                       the backend actually exposes.
    //   (b) request-shape : append the missing field(s) the route reads from
    //                       req.body to the FE inline body literal as null.
    // Other sub-cases (no backend route at all, response-shape) fall through
    // to the cascade.
    if (defect.category === 'impossible-data-flow') {
      const idx = next.findIndex(f => f.path === defect.file);
      if (idx >= 0) {
        const file = next[idx];
        // (a) wrong-method
        const wrongMethod = /backend only exposes `(\w+)\b/.exec(defect.humanReason);
        if (wrongMethod && defect.line) {
          const desired = wrongMethod[1];
          const lines = file.content.split('\n');
          const target = lines[defect.line - 1];
          if (target) {
            // Replace `method: 'XXX'` (single or double quotes).
            const patched = target.replace(
              /(method\s*:\s*['"])([A-Z]+)(['"])/,
              (_m, p1, _p2, p3) => `${p1}${desired}${p3}`,
            );
            if (patched !== target) {
              lines[defect.line - 1] = patched;
              next[idx] = { ...file, content: lines.join('\n') };
              applied++;
              continue;
            }
          }
        }
        // (b) request-shape — humanReason includes [a, b]
        const missingMatch = /omits field\(s\) \[([^\]]+)\]/.exec(defect.humanReason);
        if (missingMatch && defect.line) {
          const missing = missingMatch[1].split(',').map(s => s.trim()).filter(Boolean);
          const lines = file.content.split('\n');
          // Scan a small window for the body literal.
          for (let i = defect.line - 1; i < Math.min(lines.length, defect.line + 10); i++) {
            const target = lines[i];
            // Match `JSON.stringify({ ... })` or `body: { ... }`
            const bodyRe = /(JSON\.stringify\s*\(\s*\{)([^{}]*)(\}\s*\))|(body\s*:\s*\{)([^{}]*)(\})/;
            const m = bodyRe.exec(target);
            if (m) {
              const open = m[1] ?? m[4];
              const inner = m[2] ?? m[5] ?? '';
              const close = m[3] ?? m[6];
              const trimmed = inner.trim();
              const additions = missing.map(n => `${n}: null`).join(', ');
              const newInner = trimmed
                ? `${trimmed}${trimmed.endsWith(',') ? ' ' : ', '}${additions}`
                : ` ${additions} `;
              const patched = target.replace(bodyRe, `${open}${newInner}${close}`);
              if (patched !== target) {
                lines[i] = patched;
                next[idx] = { ...file, content: lines.join('\n') };
                applied++;
                break;
              }
            }
          }
          if (next[idx] !== file) continue;
        }
      }
      remaining.push(defect);
      continue;
    }

    // circular-ui / dead-route / response-shape impossible-data-flow:
    // intentionally not auto-patched (too lossy without AST). They fall
    // through to the Stage 15 cascade as `[semantic]` strings consumed by
    // SLM repair / template basement.
    remaining.push(defect);
  }

  return { files: next, fixesApplied: applied, consumed, remainingDefects: remaining };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchAll(content: string, re: RegExp): Array<{ index: number; match: string }> {
  const out: Array<{ index: number; match: string }> = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ index: m.index, match: m[0] });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

export {
  parseErrors,
  analyzeAndFix,
  validateImportPaths,
  addDependenciesToPackageJson,
  fixTSGenericBracketMismatch,
  formatVerificationErrors,
  formatSemanticErrors,
};
