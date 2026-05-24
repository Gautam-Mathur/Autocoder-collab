/**
 * ARCHITECT — Blueprint owner (Fusion mode).
 * Wraps AutoCoder's `architecture-planner.planArchitecture` and writes the
 * result to both RuFlo memory and `legacyCtx.architecture` so downstream
 * stages (Coder → generateProjectFromPlan) can consume it.
 *
 * Reads:  legacyCtx.plan, legacyCtx.reasoning, legacyCtx.detectedDomain
 * Writes: ArchitectOutput { architecture, fileGraph }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import type { AgentRunContext } from '../agent-runner.js';
import type {
  ArchitectOutput,
  ArchitectureModule,
  FileNode,
  PlannerOutput,
  TaskSpec,
} from '../types.js';

export async function runArchitect(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<ArchitectOutput> {
  const planner = ledger.read('Architect', 'planner') as PlannerOutput | null;
  const spec = ledger.read('Architect', 'taskSpec') as TaskSpec | null;
  if (!planner) throw new Error('Architect: no planner output in memory');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = runCtx.legacyCtx as any | undefined;
  let realArch: { modules?: Array<{ name: string; type?: string; responsibility?: string }>; techStack?: string[] } | null = null;

  if (ctx?.plan) {
    try {
      const mod = await import('../../architecture-planner.js');
      const arch = mod.planArchitecture(ctx.plan, ctx.reasoning ?? null, ctx.detectedDomain ?? spec?.domain);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      realArch = arch as any;
      ctx.architecture = arch;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[RuFlo:Architect] planArchitecture failed, using fallback:', (e as Error).message);
    }
  }

  // Synthesize modules: prefer the real architecture, otherwise project from planner features.
  const modules: ArchitectureModule[] = realArch?.modules?.length
    ? realArch.modules.map((m) => ({
        name: pascalCase(m.name),
        type: classify(m.type ?? m.name),
        responsibility: m.responsibility ?? m.name,
      }))
    : planner.features.map((f) => ({
        name: pascalCase(f.name),
        type: classify(f.name),
        responsibility: f.acceptanceCriteria[0] ?? f.name,
      }));

  // Guarantee Contract 1 — every planner feature has a module.
  for (const f of planner.features) {
    const fp = pascalCase(f.name);
    if (!modules.some((m) => canonical(m.name).includes(canonical(fp)) || canonical(fp).includes(canonical(m.name)))) {
      modules.push({ name: fp, type: classify(f.name), responsibility: f.acceptanceCriteria[0] ?? f.name });
    }
  }

  // Project the fileGraph from the modules (used by Reviewer for orphan checks).
  const fileGraph: FileNode[] = [
    { file: 'src/main.tsx', exports: [], imports: ['./App'] },
    { file: 'src/App.tsx', exports: ['default'], imports: modules.map((m) => `./components/${m.name}`) },
  ];
  for (const m of modules) {
    if (m.type === 'page') fileGraph.push({ file: `src/pages/${m.name}.tsx`, exports: [m.name], imports: [`../components/${m.name}`] });
    if (m.type === 'api')  fileGraph.push({ file: `src/api/${camelCase(m.name)}.ts`, exports: [`get${m.name}`, `create${m.name}`], imports: [] });
    fileGraph.push({ file: `src/components/${m.name}.tsx`, exports: [m.name], imports: [] });
  }

  return {
    architecture: { modules, techStack: realArch?.techStack ?? ['react', 'typescript', 'vite', 'tailwind'] },
    fileGraph,
  };
}

function pascalCase(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Module';
}
function camelCase(s: string): string {
  const p = pascalCase(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
}
function canonical(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function classify(name: string): ArchitectureModule['type'] {
  const n = name.toLowerCase();
  if (n.includes('api') || n.includes('endpoint') || n.includes('route') || n.includes('payment')) return 'api';
  if (n.includes('page') || n.includes('dashboard') || n.includes('view') || n.includes('panel') || n.includes('manage')) return 'page';
  if (n.includes('service') || n.includes('engine')) return 'service';
  return 'component';
}
