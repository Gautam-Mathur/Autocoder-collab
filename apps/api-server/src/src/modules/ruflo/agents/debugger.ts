/**
 * DEBUGGER — Bounded surgical repair
 * Repairing files flagged with failures or bugs.
 *
 * Reads:  mem.taskSpec, mem.coder.sourceFiles, mem.tester.failureReport
 * Writes: DebuggerOutput { repairDiffs[] }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import { logEvent } from '../observability-sink.js';
import { runSLM, registerStageTemplate } from '../../slm-inference-engine.js';
import type { AgentRunContext } from '../agent-runner.js';
import type { CoderOutput, DebuggerOutput, RepairDiff, TesterOutput, TaskSpec } from '../types.js';

export const MAX_PATCH_SIZE = 100000;

registerStageTemplate({
  stage: 'Debugger',
  systemPrompt: `You are the Debugger agent in a multi-agent system.
Your job is to read the Tester's failure report, Queen's task specification, and the Coder's generated sourceFiles, and output repaired file contents for the files containing bugs.
Specifically, you must generate a JSON object with:
- repairDiffs: Array of repaired files. Each repaired file has:
  - file: path of the file containing the bug
  - content: the FULL, complete repaired content of the file (do not truncate or use comments like // ...rest of code)
  - source: "Debugger"
  - sizeBytes: byte length of the content (integer)

Focus on this instruction: "{agentTask}"`,
  userPromptBuilder: (context: Record<string, any>) => `Queen's Task Spec:\n${JSON.stringify(context.taskSpec, null, 2)}\n\nTester Failure Report:\n${JSON.stringify(context.failureReport, null, 2)}\n\nCoder Source Files:\n${JSON.stringify(context.sourceFiles, null, 2)}`,
  outputSchema: {
    type: 'object',
    properties: {
      repairDiffs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            content: { type: 'string' },
            source: { type: 'string' },
            sizeBytes: { type: 'integer' }
          },
          required: ['file', 'content', 'source', 'sizeBytes']
        }
      }
    },
    required: ['repairDiffs']
  },
  maxTokens: 2048,
  temperature: 0.1
});

export async function runDebugger(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<DebuggerOutput> {
  const taskSpec = ledger.read('Debugger', 'taskSpec') as TaskSpec | null;
  const coder = ledger.read('Debugger', 'coder') as CoderOutput | null;
  const tester = ledger.read('Debugger', 'tester') as TesterOutput | null;

  if (!taskSpec || !coder) {
    throw new Error('Debugger: missing taskSpec or coder output in memory');
  }

  const agentTask = taskSpec.agentTasks?.Debugger || 'Fix bugs and test failures.';
  const failureReport = tester?.failureReport ?? [];

  if (failureReport.length > 0) {
    const slmResult = await runSLM<DebuggerOutput>('Debugger', { taskSpec, failureReport, sourceFiles: coder.sourceFiles, agentTask });
    if (slmResult.success && slmResult.data) {
      return slmResult.data;
    }
  }

  // Standalone fallback — light syntax cleanup over the Coder's sourceFiles map.
  const diffs: RepairDiff[] = [];
  for (const [file, content] of Object.entries(coder.sourceFiles)) {
    const repaired = lightFix(content);
    if (repaired === content) continue;
    const sizeBytes = Buffer.byteLength(repaired, 'utf8');
    if (sizeBytes > MAX_PATCH_SIZE) {
      logEvent({ type: 'patch_oversized', agent: 'Debugger', file, size: sizeBytes, limit: MAX_PATCH_SIZE });
      continue;
    }
    diffs.push({ file, content: repaired, source: 'Debugger', sizeBytes });
  }
  return { repairDiffs: diffs };
}

function lightFix(content: string): string {
  let out = content.replace(/[ \t]+$/gm, '').replace(/\r\n/g, '\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}
