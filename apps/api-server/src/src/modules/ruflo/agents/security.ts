/**
 * SECURITY — Cross-cutting scanner
 * Auditing generated code for vulnerabilities and policy compliance.
 *
 * Reads:  mem.taskSpec, mem.coder.sourceFiles, mem.system (optional)
 * Writes: SecurityOutput { securityReport }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import { runSLM, registerStageTemplate } from '../../slm-inference-engine.js';
import type { AgentRunContext } from '../agent-runner.js';
import type { CoderOutput, SecurityIssue, SecurityOutput, SystemOutput, TaskSpec } from '../types.js';

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA |OPENSSH )?PRIVATE KEY-----/,
];

registerStageTemplate({
  stage: 'Security',
  systemPrompt: `You are the Security agent in a multi-agent system.
Your job is to read the Queen's task specification, the Coder's generated sourceFiles, and optional System API routes/models, then audit them for security vulnerabilities (e.g. SQL injection, XSS, insecure storage, authentication bypass, eval use, hardcoded credentials, CSRF).
Specifically, you must generate a JSON object with:
- securityReport:
  - issues: Array of security issues found. Each has:
    - severity: "critical" | "high" | "medium" | "low"
    - message: description of the vulnerability and how to fix it
    - location: file path or route handler where the issue is located
  - scannedAt: timestamp in milliseconds (integer)

Focus on this instruction: "{agentTask}"`,
  userPromptBuilder: (context: Record<string, any>) => `Queen's Task Spec:\n${JSON.stringify(context.taskSpec, null, 2)}\n\nSystem Specs:\n${JSON.stringify(context.system, null, 2)}\n\nCoder Source Files:\n${JSON.stringify(context.sourceFiles, null, 2)}`,
  outputSchema: {
    type: 'object',
    properties: {
      securityReport: {
        type: 'object',
        properties: {
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                message: { type: 'string' },
                location: { type: 'string' }
              },
              required: ['severity', 'message', 'location']
            }
          },
          scannedAt: { type: 'integer' }
        },
        required: ['issues', 'scannedAt']
      }
    },
    required: ['securityReport']
  },
  maxTokens: 1536,
  temperature: 0.1
});

export async function runSecurity(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<SecurityOutput> {
  const taskSpec = ledger.read('Security', 'taskSpec') as TaskSpec | null;
  const system = ledger.read('Security', 'system') as SystemOutput | null;
  const coder  = ledger.read('Security', 'coder')  as CoderOutput  | null;

  if (!taskSpec || !coder) {
    throw new Error('Security: missing taskSpec or coder output in memory');
  }

  const agentTask = taskSpec.agentTasks?.Security || 'Audit security.';

  const slmResult = await runSLM<SecurityOutput>('Security', { taskSpec, system, sourceFiles: coder.sourceFiles, agentTask });
  if (slmResult.success && slmResult.data) {
    return slmResult.data;
  }

  // Standalone fallback: light regex rules scanner.
  const issues: SecurityIssue[] = [];

  if (system) {
    for (const r of system.apiRoutes) {
      if (r.method !== 'GET') {
        issues.push({
          severity: 'medium',
          message: `Mutating route ${r.method} ${r.path} has no documented auth check`,
          location: r.handler,
        });
      }
    }
  }

  for (const [file, content] of Object.entries(coder.sourceFiles)) {
    if (/\beval\s*\(/.test(content)) {
      issues.push({ severity: 'high', message: 'eval() use detected', location: file });
    }
    for (const pat of SECRET_PATTERNS) {
      if (pat.test(content)) {
        issues.push({ severity: 'critical', message: 'Possible hard-coded secret', location: file });
        break;
      }
    }
  }

  return { securityReport: { issues, scannedAt: Date.now() } };
}
