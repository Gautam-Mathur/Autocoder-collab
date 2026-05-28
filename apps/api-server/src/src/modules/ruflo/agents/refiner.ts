/**
 * REFINER — Optimization and polish designer
 * Analyzes generated source code and identifies optimization opportunities.
 *
 * Reads:  mem.taskSpec, mem.coder.sourceFiles
 * Writes: RefinerOutput { scoreBefore, scoreExpected, optimizations[] }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import { runSLM, registerStageTemplate } from '../../slm-inference-engine.js';
import type { AgentRunContext } from '../agent-runner.js';
import type { CoderOutput, RefinerOutput, TaskSpec } from '../types.js';

registerStageTemplate({
  stage: 'Refiner',
  systemPrompt: `You are the Refiner agent in a multi-agent system.
Your job is to read the Queen's task specification and the Coder's generated sourceFiles (from Pass 2), and identify opportunities for code optimization, readability polish, performance tuning, or styling enhancements.
Specifically, you must generate a JSON object with:
1. scoreBefore: Estimated quality/readability score before refinement (0-100)
2. scoreExpected: Target expected score after these optimizations are applied (0-100)
3. optimizations: Array of recommended optimizations. Each optimization has:
   - id: e.g. "OPT001"
   - file: path of the file to optimize
   - pattern: code pattern, module, or function to optimize
   - recommendation: detailed instructions on how Coder should refine this file

Focus on this instruction: "{agentTask}"`,
  userPromptBuilder: (context: Record<string, any>) => `Queen's Task Spec:\n${JSON.stringify(context.taskSpec, null, 2)}\n\nCoder Source Files:\n${JSON.stringify(context.sourceFiles, null, 2)}`,
  outputSchema: {
    type: 'object',
    properties: {
      scoreBefore: { type: 'integer' },
      scoreExpected: { type: 'integer' },
      optimizations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            file: { type: 'string' },
            pattern: { type: 'string' },
            recommendation: { type: 'string' }
          },
          required: ['id', 'file', 'pattern', 'recommendation']
        }
      }
    },
    required: ['scoreBefore', 'scoreExpected', 'optimizations']
  },
  maxTokens: 1024,
  temperature: 0.2
});

export async function runRefiner(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<RefinerOutput> {
  const taskSpec = ledger.read('Refiner', 'taskSpec') as TaskSpec | null;
  const coder = ledger.read('Refiner', 'coder') as CoderOutput | null;

  if (!taskSpec || !coder) {
    throw new Error('Refiner: missing taskSpec or coder output in memory');
  }

  const agentTask = taskSpec.agentTasks?.Refiner || 'Optimize and polish the codebase.';

  const slmResult = await runSLM<RefinerOutput>('Refiner', { taskSpec, sourceFiles: coder.sourceFiles, agentTask });
  if (slmResult.success && slmResult.data) {
    return slmResult.data;
  }

  // Standalone fallback: empty optimizations list
  return {
    scoreBefore: 80,
    scoreExpected: 80,
    optimizations: []
  };
}
