/**
 * CODER — Compiler / Code Generator
 * Generates and refines project source files across 3 passes.
 *
 * Reads:  mem.taskSpec, mem.planner, mem.system, mem.designer, mem.architect,
 *         mem.tester (Pass 2), mem.debugger (Pass 2), mem.security (Pass 2), mem.reviewer (Pass 2),
 *         mem.refiner (Pass 3)
 * Writes: CoderOutput { sourceFiles }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import { runSLM, registerStageTemplate } from '../../slm-inference-engine.js';
import type { AgentRunContext } from '../agent-runner.js';
import type {
  ArchitectOutput,
  CoderOutput,
  DesignerOutput,
  FileNode,
  SystemOutput,
  TaskSpec,
  PlannerOutput,
  TesterOutput,
  DebuggerOutput,
  SecurityOutput,
  ReviewerOutput,
  RefinerOutput,
} from '../types.js';

registerStageTemplate({
  stage: 'Coder',
  systemPrompt: `You are the Coder agent in a multi-agent system.
Your job is to generate or modify source code for a specific file based on the system design, tester/debugger feedback, or refiner suggestions.
You must output a JSON object containing:
- code: The full, complete source code content for the requested file. Do not truncate the code. Do not include markdown code fences or quotes inside the code string itself.`,
  userPromptBuilder: (context: Record<string, any>) => {
    return `Generate/modify the file: "${context.filePath}"
Pass Phase: ${context.passType}
Target Instructions: ${context.instructions}

Design Specification:
${JSON.stringify(context.designSpec, null, 2)}

Feedback / Fixes / Suggestions:
${JSON.stringify(context.feedback, null, 2)}

Current Source Code (if any):
${context.currentCode ?? 'None (create new file)'}`;
  },
  outputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Full source code content' }
    },
    required: ['code']
  },
  maxTokens: 2048,
  temperature: 0.1
});

export async function runCoder(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<CoderOutput> {
  const taskSpec = ledger.read('Coder', 'taskSpec') as TaskSpec | null;
  const planner = ledger.read('Coder', 'planner') as PlannerOutput | null;
  const system = ledger.read('Coder', 'system') as SystemOutput | null;
  const designer = ledger.read('Coder', 'designer') as DesignerOutput | null;
  const architect = ledger.read('Coder', 'architect') as ArchitectOutput | null;

  if (!architect || !taskSpec || !planner || !system || !designer) {
    throw new Error('Coder: missing required upstream design artifacts in memory');
  }

  // Detect current pass by checking verification outputs in memory
  const tester = ledger.read('Coder', 'tester') as TesterOutput | null;
  const refiner = ledger.read('Coder', 'refiner') as RefinerOutput | null;

  if (refiner) {
    // PASS 3: Refinement / Polish
    const previousCoder = ledger.read('Coder', 'coder') as CoderOutput | null;
    const sourceFiles = { ...(previousCoder?.sourceFiles ?? {}) };

    for (const opt of refiner.optimizations) {
      const filePath = opt.file;
      if (!sourceFiles[filePath]) continue;

      const instructions = `Apply the following optimization to the file:\nPattern: ${opt.pattern}\nRecommendation: ${opt.recommendation}`;
      const res = await runSLM<{ code: string }>('Coder', {
        filePath,
        designSpec: { taskSpec, planner, system, designer, architect },
        passType: 'Pass 3: Refinement & Polish',
        instructions,
        feedback: { optimization: opt },
        currentCode: sourceFiles[filePath]
      });

      if (res.success && res.data) {
        sourceFiles[filePath] = res.data.code;
      }
    }

    return { sourceFiles };

  } else if (tester) {
    // PASS 2: Hardening & Bug Fixes
    const debuggerOutput = ledger.read('Coder', 'debugger') as DebuggerOutput | null;
    const security = ledger.read('Coder', 'security') as SecurityOutput | null;
    const reviewer = ledger.read('Coder', 'reviewer') as ReviewerOutput | null;
    const previousCoder = ledger.read('Coder', 'coder') as CoderOutput | null;
    const sourceFiles = { ...(previousCoder?.sourceFiles ?? {}) };

    const filesToFix = new Set<string>();
    for (const issue of tester.failureReport) filesToFix.add(issue.file);
    if (debuggerOutput) {
      for (const patch of debuggerOutput.repairDiffs) filesToFix.add(patch.file);
    }
    if (security?.securityReport) {
      for (const issue of security.securityReport.issues) {
        if (issue.location) filesToFix.add(issue.location);
      }
    }
    if (reviewer) {
      for (const annot of reviewer.annotations) filesToFix.add(annot.file);
    }

    for (const filePath of filesToFix) {
      if (!sourceFiles[filePath]) continue;

      const fileTesterIssues = tester.failureReport.filter(i => i.file === filePath);
      const fileDebuggerDiffs = debuggerOutput?.repairDiffs.filter(i => i.file === filePath) ?? [];
      const fileSecurityIssues = security?.securityReport.issues.filter(i => i.location === filePath) ?? [];
      const fileReviewerAnnots = reviewer?.annotations.filter(i => i.file === filePath) ?? [];

      const instructions = `Fix bugs, security issues, and quality annotations in this file. Verify props, imports, and exports match the design specs.`;
      const res = await runSLM<{ code: string }>('Coder', {
        filePath,
        designSpec: { taskSpec, planner, system, designer, architect },
        passType: 'Pass 2: Hardening & Bug Fixes',
        instructions,
        feedback: {
          testerIssues: fileTesterIssues,
          debuggerDiffs: fileDebuggerDiffs,
          securityIssues: fileSecurityIssues,
          reviewerAnnotations: fileReviewerAnnots
        },
        currentCode: sourceFiles[filePath]
      });

      if (res.success && res.data) {
        sourceFiles[filePath] = res.data.code;
      }
    }

    return { sourceFiles };

  } else {
    // PASS 1: Initial Scaffolding
    const sourceFiles: Record<string, string> = {};
    const fileList = ['package.json', 'index.html', ...architect.fileGraph.map(n => n.file)];

    for (const filePath of fileList) {
      const instructions = `Generate the initial scaffolding code for ${filePath}. If it is a React component or page, build a premium user interface with colors and design styles from styleTokens. If it is package.json or index.html, generate valid files configured for a React + TypeScript + Vite project.`;
      const res = await runSLM<{ code: string }>('Coder', {
        filePath,
        designSpec: { taskSpec, planner, system, designer, architect },
        passType: 'Pass 1: Initial Scaffolding',
        instructions,
        feedback: {},
        currentCode: null
      });

      if (res.success && res.data) {
        sourceFiles[filePath] = res.data.code;
      } else {
        // Fallback stubbing
        sourceFiles[filePath] = stubForPath(filePath, architect.fileGraph.find(n => n.file === filePath) || { file: filePath, exports: [], imports: [] }, designer, system);
      }
    }

    return { sourceFiles };
  }
}

function stubForPath(file: string, node: FileNode, designer: DesignerOutput | null, system: SystemOutput | null): string {
  if (file === 'package.json') return packageJsonStub();
  if (file === 'index.html') return indexHtmlStub();
  if (file.endsWith('.tsx')) return tsxStub(node, designer);
  if (file.endsWith('.ts'))  return tsStub(node, system);
  return `// ${file}\n// TODO: implementation\n`;
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
function indexHtmlStub(): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"/><title>RuFlo App</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`;
}
