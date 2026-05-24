/**
 * CODER — Compiler (Fusion mode). Makes ZERO architectural decisions.
 * Wraps AutoCoder's `plan-driven-generator.generateProjectFromPlan` (the real
 * code generator that produces hundreds of files) and `dependency-resolver`.
 * Writes the produced files back to legacyCtx.files so the rest of the
 * pipeline (Debugger, Reviewer, Tester, Ship Gate) sees real source code.
 *
 * Reads:  legacyCtx.plan / frozenPlan, designSystem, schemaDesign, apiDesign
 * Writes: CoderOutput { sourceFiles }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { logEvent } from '../observability-sink.js';
import { StageLedger } from '../stage-ledger.js';
import type { AgentRunContext } from '../agent-runner.js';
import type {
  ArchitectOutput,
  CoderOutput,
  DesignerOutput,
  FileNode,
  SystemOutput,
} from '../types.js';

export async function runCoder(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<CoderOutput> {
  const architect = ledger.read('Coder', 'architect') as ArchitectOutput | null;
  const system    = ledger.read('Coder', 'system')    as SystemOutput    | null;
  const designer  = ledger.read('Coder', 'designer')  as DesignerOutput  | null;
  if (!architect) throw new Error('Coder: missing architect output');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = runCtx.legacyCtx as any | undefined;

  // PRIMARY PATH — call the real codegen (generateProjectFromPlan).
  if (ctx?.plan) {
    try {
      const planForCodegen = ctx.frozenPlan ?? ctx.plan;
      const gen = await import('../../plan-driven-generator.js');
      const enrichment = {
        designSystem:    ctx.designSystem,
        schemaDesign:    ctx.schemaDesign,
        apiDesign:       ctx.apiDesign,
        componentTree:   ctx.componentTree,
        functionalitySpec: ctx.functionalitySpec,
        architecture:    ctx.architecture,
        reasoning:       ctx.reasoning,
        detectedDomain:  ctx.detectedDomain,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (gen as any).generateProjectFromPlan(planForCodegen, undefined, enrichment) as { files: Array<{ path: string; content: string; language?: string }>; snapshotHash: string | null };

      if (result?.files?.length) {
        ctx.files = result.files;
        if (result.snapshotHash) ctx.snapshotHash = result.snapshotHash;

        // Stage 11.5 — Import Validation Gate: strip hallucinated package
        // imports BEFORE dependency resolution so the manifest never asks
        // npm to install a package that does not exist.
        try {
          const iv = await import('../../import-validator.js');
          const validation = (iv as any).validateImports(ctx.files);
          ctx.files = (iv as any).applyValidation(ctx.files, validation);
          ctx.importValidation = validation;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[RuFlo:Coder] import validation failed:', (e as Error).message);
        }

        // Run dependency resolver and merge the result into package.json so
        // the delivered project actually installs the packages it imports.
        try {
          const dr = await import('../../dependency-resolver.js');
          const manifest = dr.resolveDependencies(planForCodegen, ctx.files, ctx.detectedDomain);
          ctx.dependencyManifest = manifest;
          applyManifestToPackageJson(ctx.files, manifest);
          // Legacy stage 12 also: normalises the package.json (sorted keys,
          // pinned versions) and queues a dependency snapshot prebuild.
          await finalizePackageJsonAndSnapshot(ctx);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[RuFlo:Coder] resolveDependencies failed:', (e as Error).message);
        }

        const sourceFiles: Record<string, string> = {};
        for (const f of ctx.files as Array<{ path: string; content: string }>) sourceFiles[f.path] = f.content;
        logEvent({ type: 'agent_complete', agent: 'Coder', durationMs: 0 });
        return { sourceFiles };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[RuFlo:Coder] generateProjectFromPlan failed, falling back to stubs:', (e as Error).message);
    }
  }

  // FALLBACK PATH — stub-only emission (used in stand-alone RuFlo runs).
  const sourceFiles: Record<string, string> = {};
  for (const node of architect.fileGraph) sourceFiles[node.file] = stubFor(node, designer, system);
  if (!sourceFiles['package.json']) sourceFiles['package.json'] = packageJsonStub();
  if (!sourceFiles['index.html'])   sourceFiles['index.html']   = indexHtmlStub();
  if (ctx) {
    ctx.files = Object.entries(sourceFiles).map(([path, content]) => ({
      path, content, language: path.split('.').pop() || '',
    }));
  }
  return { sourceFiles };
}

function stubFor(node: FileNode, designer: DesignerOutput | null, system: SystemOutput | null): string {
  if (node.file.endsWith('.tsx')) return tsxStub(node, designer);
  if (node.file.endsWith('.ts'))  return tsStub(node, system);
  return `// ${node.file}\n// TODO: implementation\n`;
}
function tsxStub(node: FileNode, _designer: DesignerOutput | null): string {
  const name = (node.exports[0] || baseName(node.file)).replace(/[^a-zA-Z0-9]/g, '');
  const isDefault = node.exports.includes('default');
  const importLines = node.imports.filter((i) => i.startsWith('.')).map((i) => `// import ... from '${i}';`).join('\n');
  return `${importLines}\n\n${isDefault ? 'export default function ' : 'export function '}${name}() {\n  return (\n    <div className="p-4">\n      <h2 className="text-lg font-semibold">${name}</h2>\n      <p className="text-sm text-slate-500">Generated by RuFlo Coder (stub).</p>\n    </div>\n  );\n}\n`.trimStart();
}
function tsStub(node: FileNode, _system: SystemOutput | null): string {
  if (node.exports.length === 0) return `// ${node.file}\nexport {};\n`;
  const fns = node.exports.map((e) => `export function ${e}(...args: unknown[]): unknown {\n  return null;\n}`).join('\n\n');
  return `// ${node.file}\n${fns}\n`;
}
function baseName(file: string): string {
  const last = file.split('/').pop() ?? 'Module';
  return last.replace(/\.[^.]+$/, '');
}
function packageJsonStub(): string {
  return JSON.stringify({
    name: 'ruflo-app', private: true, version: '0.0.0', type: 'module',
    scripts: { dev: 'vite', build: 'vite build' },
    dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
    devDependencies: { vite: '^5.4.0', '@vitejs/plugin-react': '^4.3.0', typescript: '^5.5.0' },
  }, null, 2);
}
function applyManifestToPackageJson(
  files: Array<{ path: string; content: string; language?: string }>,
  manifest: { dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts?: Record<string, string> },
): void {
  const idx = files.findIndex((f) => f.path === 'package.json' || f.path.endsWith('/package.json'));
  if (idx === -1) {
    files.push({
      path: 'package.json',
      content: JSON.stringify({
        name: 'ruflo-app', private: true, version: '0.0.0', type: 'module',
        scripts: { dev: 'vite', build: 'vite build', ...(manifest.scripts ?? {}) },
        dependencies: manifest.dependencies,
        devDependencies: manifest.devDependencies,
      }, null, 2),
      language: 'json',
    });
    return;
  }
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(files[idx].content);
  } catch {
    pkg = { name: 'ruflo-app', private: true, version: '0.0.0', type: 'module' };
  }
  pkg.dependencies = { ...(pkg.dependencies as Record<string, string> | undefined ?? {}), ...manifest.dependencies };
  pkg.devDependencies = { ...(pkg.devDependencies as Record<string, string> | undefined ?? {}), ...manifest.devDependencies };
  if (manifest.scripts && Object.keys(manifest.scripts).length > 0) {
    pkg.scripts = { ...(pkg.scripts as Record<string, string> | undefined ?? {}), ...manifest.scripts };
  }
  files[idx] = { ...files[idx], content: JSON.stringify(pkg, null, 2) };
}

/**
 * Stage 12 finalisation: normalise the package.json (sorted, pinned) via
 * `upgradePackageJson`, recompute the dependency snapshot hash, and queue
 * a background prebuild via `buildSnapshotAsync`. All best-effort.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function finalizePackageJsonAndSnapshot(ctx: any): Promise<void> {
  const files = (ctx.files as Array<{ path: string; content: string; language?: string }>);
  const idx = files.findIndex((f) => f.path === 'package.json' || f.path.endsWith('/package.json'));
  if (idx === -1) return;
  try {
    const sb = await import('../../snapshot-builder.js');
    const upgraded = (sb as any).upgradePackageJson(files[idx].content);
    const cleaned = JSON.stringify(upgraded.packageJson, null, 2);
    files[idx] = { ...files[idx], content: cleaned };
    const parsed = JSON.parse(cleaned);
    const normalized = JSON.stringify({
      dependencies: Object.fromEntries(Object.entries(parsed.dependencies ?? {}).sort()),
      devDependencies: Object.fromEntries(Object.entries(parsed.devDependencies ?? {}).sort()),
    });
    const { createHash } = await import('crypto');
    const finalHash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    ctx.snapshotHash = finalHash;
    try {
      (sb as any).buildSnapshotAsync(finalHash, cleaned);
    } catch (e) {
      console.warn('[RuFlo:Coder] buildSnapshotAsync failed (non-fatal):', (e as Error).message);
    }
  } catch (e) {
    console.warn('[RuFlo:Coder] upgradePackageJson failed (non-fatal):', (e as Error).message);
  }
}

function indexHtmlStub(): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"/><title>RuFlo App</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`;
}
