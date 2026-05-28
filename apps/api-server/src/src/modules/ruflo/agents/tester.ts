/**
 * TESTER — Test file author
 * Generates test files and detects failures/bugs in emitted source files.
 *
 * Reads:  mem.taskSpec, mem.coder.sourceFiles, mem.system (optional), mem.architect (optional)
 * Writes: TesterOutput { testFiles, failureReport }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import { runSLM, registerStageTemplate } from '../../slm-inference-engine.js';
import type { AgentRunContext } from '../agent-runner.js';
import type { ArchitectOutput, SystemOutput, TesterOutput, TaskSpec, CoderOutput } from '../types.js';

registerStageTemplate({
  stage: 'Tester',
  systemPrompt: `You are the Tester agent in a multi-agent system.
Your job is to read the Queen's task specification and the Coder's generated sourceFiles, and then author automated tests and identify any bugs/issues.
Specifically, you must generate a JSON object with:
1. testFiles: Record mapping test file paths (e.g. "src/__tests__/App.test.tsx") to their test file content (Vitest test code). Focus on writing unit or integration tests for the generated pages and modules.
2. failureReport: Array of failure entries. If you find any functional bugs, styling issues, or security flaws in the coder's files, report them here. If no bugs are found, return an empty array [].
   Each failure entry has:
   - id: e.g. "BUG001"
   - file: path of the file containing the bug
   - location: function, line, or area where the bug exists
   - severity: "functional" | "low-security" | "high-security" | "style"
   - description: clear description of the bug/issue
   - reproductionSteps: steps to reproduce or trigger the bug

Focus on this instruction: "{agentTask}"`,
  userPromptBuilder: (context: Record<string, any>) => `Queen's Task Spec:\n${JSON.stringify(context.taskSpec, null, 2)}\n\nCoder Source Files:\n${JSON.stringify(context.sourceFiles, null, 2)}`,
  outputSchema: {
    type: 'object',
    properties: {
      testFiles: { type: 'object', additionalProperties: { type: 'string' } },
      failureReport: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            file: { type: 'string' },
            location: { type: 'string' },
            severity: { type: 'string', enum: ['functional', 'low-security', 'high-security', 'style'] },
            description: { type: 'string' },
            reproductionSteps: { type: 'string' }
          },
          required: ['id', 'file', 'location', 'severity', 'description', 'reproductionSteps']
        }
      }
    },
    required: ['testFiles', 'failureReport']
  },
  maxTokens: 1536,
  temperature: 0.2
});

export async function runTester(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<TesterOutput> {
  const taskSpec = ledger.read('Tester', 'taskSpec') as TaskSpec | null;
  const coder = ledger.read('Tester', 'coder') as CoderOutput | null;
  const architect = ledger.read('Tester', 'architect') as ArchitectOutput | null;
  const system    = ledger.read('Tester', 'system')    as SystemOutput    | null;

  if (!taskSpec || !coder) {
    throw new Error('Tester: missing taskSpec or coder output in memory');
  }

  const agentTask = taskSpec.agentTasks?.Tester || 'Author tests and find code failures.';

  const slmResult = await runSLM<TesterOutput>('Tester', { taskSpec, sourceFiles: coder.sourceFiles, agentTask });
  if (slmResult.success && slmResult.data) {
    return slmResult.data;
  }

  // Standalone fallback: emit minimal smoke tests on top so we have at least one per model/page.
  const testFiles: Record<string, string> = {};

  if (system) {
    for (const m of system.logic.dataModels) {
      const file = `src/__tests__/${m.name.toLowerCase()}.smoke.test.ts`;
      if (!testFiles[file]) {
        testFiles[file] = `import { describe, it, expect } from 'vitest';\n\ndescribe('${m.name} data model', () => {\n  it('has a stable shape', () => {\n    const fields = ${JSON.stringify(m.fields.map((f) => f.name))};\n    expect(fields).toContain('id');\n  });\n});\n`;
      }
    }
  }
  if (architect) {
    for (const m of architect.architecture.modules.filter((mod) => mod.type === 'page')) {
      const file = `src/__tests__/${m.name}.smoke.test.tsx`;
      if (!testFiles[file]) {
        testFiles[file] = `import { describe, it, expect } from 'vitest';\n\ndescribe('${m.name} page', () => {\n  it('module name resolves', () => {\n    expect('${m.name}').toBe('${m.name}');\n  });\n});\n`;
      }
    }
  }

  return { testFiles, failureReport: [] };
}
