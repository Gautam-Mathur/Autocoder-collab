/**
 * DEBUGGER — Bounded surgical repair (Fusion mode).
 * Wraps AutoCoder's `post-generation-validator.validateAndFix` — the real
 * battle-tested validator that runs up to 3 fix iterations across imports,
 * syntax, and config files. Writes diffs into mem.debugger.repairDiffs and
 * mutates legacyCtx.files in place.
 *
 * Reads:  legacyCtx.files (post-Coder)
 * Writes: DebuggerOutput { repairDiffs[] }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { logEvent } from '../observability-sink.js';
import { StageLedger } from '../stage-ledger.js';
import type { AgentRunContext } from '../agent-runner.js';
import type { CoderOutput, DebuggerOutput, RepairDiff } from '../types.js';

export const MAX_PATCH_SIZE = 4096;

export async function runDebugger(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<DebuggerOutput> {
  const coder = ledger.read('Debugger', 'coder') as CoderOutput | null;
  if (!coder) throw new Error('Debugger: missing coder output');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = runCtx.legacyCtx as any | undefined;
  const diffs: RepairDiff[] = [];

  // PRIMARY PATH — wrap validateAndFix.
  if (ctx?.files && Array.isArray(ctx.files) && ctx.files.length > 0) {
    try {
      const before = new Map<string, string>();
      for (const f of ctx.files as Array<{ path: string; content: string }>) before.set(f.path, f.content);

      const pgv = await import('../../post-generation-validator.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (pgv as any).validateAndFix(ctx.files, 3) as {
        valid?: boolean;
        files?: Array<{ path: string; content: string; language?: string }>;
        fixesApplied?: string[];
        issues?: Array<{ severity?: string; message?: string } | string>;
      };

      if (result?.files) ctx.files = result.files;

      // Emit the CANONICAL validationSummary shape that
      // pipeline-orchestrator.ts and conversation-phase-handler.ts expect:
      //   { passes, issuesFound, issuesFixed, unfixableIssues, warnings? }
      const issues = Array.isArray(result?.issues) ? result!.issues : [];
      const fixesApplied = result?.fixesApplied ?? [];
      const unfixableIssues = issues
        .map((i) => (typeof i === 'string' ? i : i?.severity === 'error' ? (i?.message ?? '') : ''))
        .filter((m): m is string => !!m);
      const warnings = issues.filter(
        (i) => typeof i !== 'string' && i?.severity === 'warning',
      ).length;
      ctx.validationSummary = {
        passes: 1,
        issuesFound: issues.length,
        issuesFixed: fixesApplied.length,
        unfixableIssues,
        warnings,
      };

      for (const f of ctx.files as Array<{ path: string; content: string }>) {
        const prev = before.get(f.path);
        if (prev !== undefined && prev !== f.content) {
          const sizeBytes = Buffer.byteLength(f.content, 'utf8');
          if (sizeBytes > MAX_PATCH_SIZE) {
            logEvent({ type: 'patch_oversized', agent: 'Debugger', file: f.path, size: sizeBytes, limit: MAX_PATCH_SIZE });
            continue;
          }
          diffs.push({ file: f.path, content: f.content, source: 'Debugger', sizeBytes });
        }
      }
      return { repairDiffs: diffs };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[RuFlo:Debugger] validateAndFix failed, using light cleanup:', (e as Error).message);
    }
  }

  // FALLBACK — light syntax cleanup over the Coder's sourceFiles map.
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
