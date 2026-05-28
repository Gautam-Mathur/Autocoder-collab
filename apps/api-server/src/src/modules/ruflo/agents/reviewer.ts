/**
 * REVIEWER — Quality scorer
 * Evaluates overall code quality, calculates a quality score, and generates annotations.
 *
 * Reads:  mem.taskSpec, mem.coder.sourceFiles, mem.security, mem.debugger, mem.architect
 * Writes: ReviewerOutput { qualityScore, annotations }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import { runSLM, registerStageTemplate } from '../../slm-inference-engine.js';
import type { AgentRunContext } from '../agent-runner.js';
import type {
  Annotation,
  ArchitectOutput,
  CoderOutput,
  DebuggerOutput,
  ReviewerOutput,
  SecurityOutput,
  TaskSpec,
} from '../types.js';

registerStageTemplate({
  stage: 'Reviewer',
  systemPrompt: `You are the Reviewer agent in a multi-agent system.
Your job is to read the Queen's task specification, the Coder's generated sourceFiles, the Debugger's repairDiffs, and the Security's report, and then calculate a final quality score (0-100) and compile a list of code quality annotations.
Specifically, you must generate a JSON object with:
1. qualityScore: An integer from 0 to 100 representing the overall quality, completeness, and cleanliness of the code.
2. annotations: Array of annotations. Each has:
   - file: path of the file
   - note: description of the warning, improvement suggestion, or error
   - agent: "Reviewer"
   - severity: "info" | "warn" | "error"

Focus on this instruction: "{agentTask}"`,
  userPromptBuilder: (context: Record<string, any>) => `Queen's Task Spec:\n${JSON.stringify(context.taskSpec, null, 2)}\n\nCoder Source Files:\n${JSON.stringify(context.sourceFiles, null, 2)}\n\nDebugger Repair Diffs:\n${JSON.stringify(context.repairDiffs, null, 2)}\n\nSecurity Report:\n${JSON.stringify(context.securityReport, null, 2)}`,
  outputSchema: {
    type: 'object',
    properties: {
      qualityScore: { type: 'integer' },
      annotations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            note: { type: 'string' },
            agent: { type: 'string', enum: ['Reviewer'] },
            severity: { type: 'string', enum: ['info', 'warn', 'error'] }
          },
          required: ['file', 'note', 'agent', 'severity']
        }
      }
    },
    required: ['qualityScore', 'annotations']
  },
  maxTokens: 1536,
  temperature: 0.2
});

export async function runReviewer(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<ReviewerOutput> {
  const taskSpec = ledger.read('Reviewer', 'taskSpec') as TaskSpec | null;
  const architect = ledger.read('Reviewer', 'architect') as ArchitectOutput | null;
  const coder     = ledger.read('Reviewer', 'coder')     as CoderOutput     | null;
  const security  = ledger.read('Reviewer', 'security')  as SecurityOutput  | null;
  const dbg       = ledger.read('Reviewer', 'debugger')  as DebuggerOutput  | null;

  if (!taskSpec || !coder) {
    throw new Error('Reviewer: missing taskSpec or coder output in memory');
  }

  const agentTask = taskSpec.agentTasks?.Reviewer || 'Rate code quality and create annotations.';

  const slmResult = await runSLM<ReviewerOutput>('Reviewer', {
    taskSpec,
    sourceFiles: coder.sourceFiles,
    repairDiffs: dbg?.repairDiffs ?? [],
    securityReport: security?.securityReport ?? { issues: [] },
    agentTask
  });

  if (slmResult.success && slmResult.data) {
    return slmResult.data;
  }

  // Standalone fallback: rules-based score calculation.
  const annotations: Annotation[] = [];
  let score = 100;

  if (architect) {
    const generated = new Set(Object.keys(coder.sourceFiles));
    for (const node of architect.fileGraph) {
      if (!generated.has(node.file)) {
        annotations.push({
          file: node.file, note: 'Architect declared file but Coder did not emit it',
          agent: 'Coder', severity: 'warn',
        });
        score -= 1;
      }
    }
  }

  if (security) {
    for (const issue of security.securityReport.issues) {
      annotations.push({
        file: issue.location ?? '(unknown)',
        note: issue.message,
        agent: 'Security',
        severity: issue.severity === 'critical' || issue.severity === 'high' ? 'error' : 'warn',
      });
      score -=
        issue.severity === 'critical' ? 15 :
        issue.severity === 'high'     ? 8  :
        issue.severity === 'medium'   ? 3  : 1;
    }
  }

  if (dbg && dbg.repairDiffs.length > 0) {
    annotations.push({
      file: '(multiple)',
      note: `${dbg.repairDiffs.length} files required surgical repair`,
      agent: 'Debugger', severity: 'info',
    });
  }

  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return { qualityScore: score, annotations };
}
