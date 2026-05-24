/**
 * SECURITY — Cross-cutting scanner (Fusion mode).
 * Wraps AutoCoder's `security-module.scanForVulnerabilities` (XSS, SQLi,
 * hard-coded secrets, command injection, etc.). Falls back to a deterministic
 * mini-scanner if the real module fails to load.
 *
 * Reads:  legacyCtx.files (post-Debugger)
 * Writes: SecurityOutput { securityReport }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import type { AgentRunContext } from '../agent-runner.js';
import type { CoderOutput, SecurityIssue, SecurityOutput, SystemOutput } from '../types.js';

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA |OPENSSH )?PRIVATE KEY-----/,
];

export async function runSecurity(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<SecurityOutput> {
  const system = ledger.read('Security', 'system') as SystemOutput | null;
  const coder  = ledger.read('Security', 'coder')  as CoderOutput  | null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = runCtx.legacyCtx as any | undefined;
  const issues: SecurityIssue[] = [];

  // PRIMARY PATH — wrap scanForVulnerabilities.
  if (ctx?.files && Array.isArray(ctx.files) && ctx.files.length > 0) {
    try {
      const sm = await import('../../security-module.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (sm as any).scanForVulnerabilities(ctx.files) as {
        issues?: Array<{ severity?: string; message?: string; description?: string; file?: string; location?: string }>;
        vulnerabilities?: Array<{ severity?: string; message?: string; description?: string; file?: string; location?: string }>;
      };
      const list = result?.issues ?? result?.vulnerabilities ?? [];
      for (const v of list) {
        const sev = (v.severity ?? 'medium').toLowerCase();
        const severity: SecurityIssue['severity'] =
          sev === 'critical' ? 'critical' : sev === 'high' ? 'high' : sev === 'low' ? 'low' : 'medium';
        issues.push({
          severity,
          message: v.message ?? v.description ?? 'Security issue',
          location: v.location ?? v.file,
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[RuFlo:Security] scanForVulnerabilities failed, using fallback:', (e as Error).message);
    }
  }

  // Always also run the lightweight rules — they catch the obvious things
  // and act as a safety net when the heavy scanner is unavailable.
  if (system) {
    for (const r of system.apiRoutes) {
      if (r.method !== 'GET' && !issues.some((i) => i.location === r.handler)) {
        issues.push({
          severity: 'medium',
          message: `Mutating route ${r.method} ${r.path} has no documented auth check`,
          location: r.handler,
        });
      }
    }
  }
  if (coder) {
    for (const [file, content] of Object.entries(coder.sourceFiles)) {
      if (/\beval\s*\(/.test(content) && !issues.some((i) => i.location === file && /eval/.test(i.message))) {
        issues.push({ severity: 'high', message: 'eval() use detected', location: file });
      }
      for (const pat of SECRET_PATTERNS) {
        if (pat.test(content) && !issues.some((i) => i.location === file && /secret/i.test(i.message))) {
          issues.push({ severity: 'critical', message: 'Possible hard-coded secret', location: file });
          break;
        }
      }
    }
  }

  return { securityReport: { issues, scannedAt: Date.now() } };
}
