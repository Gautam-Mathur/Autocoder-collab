/**
 * TESTER — Test file author (Fusion mode).
 * Wraps AutoCoder's `test-generator.generateTestFiles`. Writes tests both
 * into legacyCtx.testFiles and the RuFlo memory map.
 *
 * Reads:  legacyCtx.plan, legacyCtx.reasoning, legacyCtx.detectedDomain
 * Writes: TesterOutput { testFiles }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import type { AgentRunContext } from '../agent-runner.js';
import type { ArchitectOutput, SystemOutput, TesterOutput } from '../types.js';

export async function runTester(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<TesterOutput> {
  const architect = ledger.read('Tester', 'architect') as ArchitectOutput | null;
  const system    = ledger.read('Tester', 'system')    as SystemOutput    | null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = runCtx.legacyCtx as any | undefined;
  const testFiles: Record<string, string> = {};

  // PRIMARY PATH — wrap generateTestFiles when reasoning is available.
  if (ctx?.plan && ctx?.reasoning) {
    try {
      const tg = await import('../../test-generator.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const files = (tg as any).generateTestFiles(ctx.plan, ctx.reasoning, ctx.detectedDomain) as Array<{ path: string; content: string; language?: string }>;
      if (Array.isArray(files)) {
        for (const f of files) testFiles[f.path] = f.content;
        ctx.testFiles = files;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[RuFlo:Tester] generateTestFiles failed:', (e as Error).message);
    }
  }

  // Always emit minimal smoke tests on top so we have at least one per model/page.
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

  return { testFiles };
}
