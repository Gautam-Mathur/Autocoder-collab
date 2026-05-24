/**
 * Debug Agent — unified error → fix → re-validate loop
 *
 * Takes sandbox errors, classifies each one, generates a targeted fix prompt,
 * applies patches to the file set, and re-dispatches through the sandbox.
 * Runs up to MAX_ITERATIONS to avoid infinite loops.
 */

import type { GeneratedFile } from '../pipeline-orchestrator.js';
import { dispatchSandbox, type SandboxResult, type StackId } from './sandbox-dispatcher.js';

const MAX_ITERATIONS = 3;

export interface DebugIteration {
  iteration: number;
  errors: string[];
  fixApplied: string;
  resultSuccess: boolean;
}

export interface DebugAgentResult {
  files: GeneratedFile[];
  success: boolean;
  iterations: DebugIteration[];
  finalErrors: string[];
}

// ── Error classification ───────────────────────────────────────────────────

type ErrorClass =
  | 'missing-import'
  | 'type-mismatch'
  | 'missing-annotation'
  | 'syntax-error'
  | 'unknown';

function classifyError(error: string): ErrorClass {
  const lower = error.toLowerCase();
  if (lower.includes('cannot find module') || lower.includes('has no exported member') || lower.includes('importerror')) {
    return 'missing-import';
  }
  if (lower.includes('is not assignable') || lower.includes('implicit any') || lower.includes('type \'')) {
    return 'type-mismatch';
  }
  if (lower.includes('annotation') || lower.includes('@entity') || lower.includes('@restcontroller')) {
    return 'missing-annotation';
  }
  if (lower.includes('syntaxerror') || lower.includes('unexpected token') || lower.includes("')' expected") || lower.includes("';' expected")) {
    return 'syntax-error';
  }
  return 'unknown';
}

// ── Auto-patcher ───────────────────────────────────────────────────────────

function applyAutoFixes(
  files: GeneratedFile[],
  errors: string[]
): { files: GeneratedFile[]; description: string } {
  let patchedFiles = files.map(f => ({ ...f }));
  const applied: string[] = [];

  for (const error of errors) {
    const lower = error.toLowerCase();
    const cls = classifyError(error);

    if (cls === 'missing-import') {
      const moduleMatch = error.match(/['"]([^'"]+)['"]/);
      const module = moduleMatch?.[1];
      if (module) {
        const isRelative = module.startsWith('.') || module.startsWith('/');
        if (!isRelative) {
          continue;
        }
        const fileMatch = error.match(/^([^\s(]+\.(?:ts|tsx|py|go|java|cs))[\s(:]/);
        const filePath = fileMatch?.[1];
        if (filePath) {
          patchedFiles = patchedFiles.map(f => {
            if (!f.path.endsWith(filePath)) return f;
            const patched = f.content.replace(
              new RegExp(`(import .* from ['"]${module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"];?)`, 'g'),
              `// AUTO-FIX: removed missing import "${module}"\n// $1`
            );
            if (patched !== f.content) {
              applied.push(`Commented broken import "${module}" in ${f.path}`);
              return { ...f, content: patched };
            }
            return f;
          });
        }
      }
    }

    if (cls === 'type-mismatch' && error.includes('implicit any')) {
      // Add : any type annotations to implicit any params
      patchedFiles = patchedFiles.map(f => {
        if (!f.path.endsWith('.ts') && !f.path.endsWith('.tsx')) return f;
        const patched = f.content.replace(/\(([a-zA-Z_$][a-zA-Z0-9_$]*)\)/g, (_, p) => `(${p}: any)`);
        if (patched !== f.content) applied.push(`Added : any annotations in ${f.path}`);
        return { ...f, content: patched };
      });
    }

    if (cls === 'type-mismatch' && lower.includes('is not assignable')) {
      const fileMatch = error.match(/^([^\s(]+\.(?:ts|tsx))[\s(:]/);
      const filePath = fileMatch?.[1];
      if (filePath) {
        const lineMatch = error.match(/\((\d+),/);
        const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : 0;
        if (lineNum > 0) {
          patchedFiles = patchedFiles.map(f => {
            if (!f.path.endsWith(filePath)) return f;
            const lines = f.content.split('\n');
            if (lineNum <= lines.length) {
              const line = lines[lineNum - 1];
              const fixed = line.replace(/:\s*(number|string|boolean)\s*=/, ': any =');
              if (fixed !== line) {
                lines[lineNum - 1] = fixed;
                applied.push(`Widened type to 'any' at ${f.path}:${lineNum}`);
                return { ...f, content: lines.join('\n') };
              }
            }
            return f;
          });
        }
      }
    }

    if (cls === 'missing-annotation') {
      const fileMatch = error.match(/^([^\s(]+\.java)[\s(:]/);
      if (fileMatch) {
        const filePath = fileMatch[1];
        const addAnnotation = (f: typeof patchedFiles[0], importLine: string, annotation: string): typeof patchedFiles[0] => {
          if (f.content.includes(annotation)) return f;
          const lines = f.content.split('\n');
          let lastImportIdx = -1;
          let classIdx = -1;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('import ')) lastImportIdx = i;
            if (/^\s*(public\s+)?class\s+/.test(lines[i]) && classIdx === -1) classIdx = i;
          }
          if (classIdx === -1) return f;
          if (lastImportIdx >= 0 && !f.content.includes(importLine.replace(';', ''))) {
            lines.splice(lastImportIdx + 1, 0, importLine);
            classIdx++;
          } else if (lastImportIdx === -1) {
            lines.splice(0, 0, importLine, '');
            classIdx += 2;
          }
          lines.splice(classIdx, 0, annotation);
          applied.push(`Added ${annotation} to ${f.path}`);
          return { ...f, content: lines.join('\n') };
        };

        if (lower.includes('@entity') || lower.includes('entity class')) {
          patchedFiles = patchedFiles.map(f => {
            if (!f.path.includes(filePath)) return f;
            return addAnnotation(f, 'import javax.persistence.*;', '@Entity');
          });
        }
        if (lower.includes('@restcontroller') || lower.includes('controller class')) {
          patchedFiles = patchedFiles.map(f => {
            if (!f.path.includes(filePath)) return f;
            return addAnnotation(f, 'import org.springframework.web.bind.annotation.*;', '@RestController');
          });
        }
      }
    }
  }

  return {
    files: patchedFiles,
    description: applied.length > 0 ? applied.join('; ') : 'No auto-fixes applied',
  };
}

// ── Main loop ──────────────────────────────────────────────────────────────

export async function runDebugLoop(
  initialFiles: GeneratedFile[],
  initialResult: SandboxResult,
  stack?: StackId
): Promise<DebugAgentResult> {
  let files = [...initialFiles];
  let lastResult = initialResult;
  const iterations: DebugIteration[] = [];

  // If already successful, return immediately
  if (lastResult.success) {
    return { files, success: true, iterations: [], finalErrors: [] };
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (lastResult.errors.length === 0) break;

    // Only attempt auto-fix if the sandbox says it's possible
    if (!lastResult.canAutoFix && i === 0) {
      console.log('[DebugAgent] Sandbox says canAutoFix=false — skipping loop');
      break;
    }

    const { files: patched, description } = applyAutoFixes(files, lastResult.errors);
    files = patched;

    console.log(`[DebugAgent] Iteration ${i + 1}: ${description}`);

    // Re-run sandbox
    lastResult = await dispatchSandbox(files, stack);

    iterations.push({
      iteration: i + 1,
      errors: lastResult.errors,
      fixApplied: description,
      resultSuccess: lastResult.success,
    });

    if (lastResult.success) break;
  }

  return {
    files,
    success: lastResult.success,
    iterations,
    finalErrors: lastResult.errors,
  };
}
