/**
 * ARCHITECT — Blueprint owner
 * Defining architecture modules and the file dependency graph.
 *
 * Reads:  mem.taskSpec, mem.planner
 * Writes: ArchitectOutput { architecture, fileGraph }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import { runSLM, registerStageTemplate } from '../../slm-inference-engine.js';
import type { AgentRunContext } from '../agent-runner.js';
import type {
  ArchitectOutput,
  ArchitectureModule,
  FileNode,
  PlannerOutput,
  TaskSpec,
} from '../types.js';

registerStageTemplate({
  stage: 'Architect',
  systemPrompt: `You are the Architect agent in a multi-agent system.
Your job is to read the Queen's task specification and the Planner's feature/requirement list, then generate a system architecture and a file dependency graph.
Specifically, you must generate a JSON object with:
1. architecture:
   - modules: List of modules. Each module has:
     - name: pascal-cased name of the module
     - type: "page" | "component" | "api" | "lib" | "service"
     - responsibility: string describing what the module does
   - techStack: Array of tech stack names (e.g. ["react", "typescript", "vite", "tailwind"])
2. fileGraph: Array of file nodes. Each node has:
   - file: path of the file (e.g. "src/main.tsx", "src/App.tsx", "src/components/MyComponent.tsx")
   - exports: array of exported entities
   - imports: array of relative paths representing imported files

IMPORTANT CONTRACT REQUIREMENT: Every feature name in the Planner's feature list MUST have a corresponding module in the architecture.modules list. Do not leave any features out.

Focus on this instruction: "{agentTask}"`,
  userPromptBuilder: (context: Record<string, any>) => `Queen's Task Specification:\n${JSON.stringify(context.taskSpec, null, 2)}\n\nPlanner's Output:\n${JSON.stringify(context.planner, null, 2)}`,
  outputSchema: {
    type: 'object',
    properties: {
      architecture: {
        type: 'object',
        properties: {
          modules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string', enum: ['page', 'component', 'api', 'lib', 'service'] },
                responsibility: { type: 'string' }
              },
              required: ['name', 'type', 'responsibility']
            }
          },
          techStack: { type: 'array', items: { type: 'string' } }
        },
        required: ['modules', 'techStack']
      },
      fileGraph: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            exports: { type: 'array', items: { type: 'string' } },
            imports: { type: 'array', items: { type: 'string' } }
          },
          required: ['file', 'exports', 'imports']
        }
      }
    },
    required: ['architecture', 'fileGraph']
  },
  maxTokens: 1536,
  temperature: 0.2
});

export async function runArchitect(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<ArchitectOutput> {
  const planner = ledger.read('Architect', 'planner') as PlannerOutput | null;
  const spec = ledger.read('Architect', 'taskSpec') as TaskSpec | null;
  if (!planner) throw new Error('Architect: no planner output in memory');

  const agentTask = spec?.agentTasks?.Architect || 'Plan modules and file dependencies.';

  const slmResult = await runSLM<ArchitectOutput>('Architect', { taskSpec: spec, planner, agentTask });
  if (slmResult.success && slmResult.data) {
    return slmResult.data;
  }

  // Standalone rule-based fallback.
  const modules: ArchitectureModule[] = planner.features.map((f) => ({
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
    architecture: { modules, techStack: ['react', 'typescript', 'vite', 'tailwind'] },
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
