import { describe, it, expect } from 'vitest';
import { runVerifyThenStartGate } from '../auto-fix-engine';
import type { RunnerBranchHost } from '../repair-branch';

// Task #23 — when the doctor pass fixes one file but BREAKS a
// previously-clean file (total error count unchanged), the
// per-iteration RepairBranch must DISCARD and the live FS must be
// restored to the pre-iteration baseline. The pre-doctor error PATH
// SET (not just count) is the regression baseline.
describe('runVerifyThenStartGate: doctor regression detection', () => {
  it('discards branch + restores FS when doctor breaks a previously-clean file (count unchanged)', async () => {
    const host: RunnerBranchHost = { repairAudit: [], branchOpen: false };

    const initial = [
      { path: 'a.ts', content: 'export const x = (' }, // BROKEN initially
      { path: 'b.ts', content: 'export const y = 1;' }, // clean initially
    ];

    const disk = new Map(initial.map(f => [f.path, f.content] as const));

    // Doctor "fixes" a.ts but BREAKS b.ts — net error count is flat.
    const doctor = (files: { path: string; content: string }[]) => {
      const out: { file: string; fixed: string }[] = [];
      for (const f of files) {
        if (f.path === 'a.ts') out.push({ file: 'a.ts', fixed: 'export const x = 1;' });
        if (f.path === 'b.ts') out.push({ file: 'b.ts', fixed: 'export const y = (' });
      }
      return out;
    };

    // Lightweight stub for esbuild transform: classify content with an
    // unbalanced trailing "(" as a parser error.
    const transform = (async (code: string) => {
      const opens = (code.match(/\(/g) ?? []).length;
      const closes = (code.match(/\)/g) ?? []).length;
      if (opens !== closes) {
        const err: any = new Error('Unexpected end of file');
        err.errors = [{ text: 'Unexpected end of file', location: { line: 1, column: 0 } }];
        throw err;
      }
      return { code, map: '', warnings: [] };
    }) as any;

    const res = await runVerifyThenStartGate({
      files: initial,
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: (content) => ({ content }), // no drain repairs
      maxIterations: 1,
      branchHost: host,
      doctor,
    });

    // Live FS must be restored to baseline (a.ts still broken, b.ts clean).
    expect(disk.get('a.ts')).toBe('export const x = (');
    expect(disk.get('b.ts')).toBe('export const y = 1;');

    // Audit should show ONE discarded entry with a regression reason.
    const discarded = host.repairAudit!.filter(r => r.status === 'discarded');
    expect(discarded.length).toBe(1);
    expect(discarded[0].reason).toMatch(/regressed|increased/);

    // Gate did not converge.
    expect(res.ok).toBe(false);
  });

  // Task #23 — true snapshot parity for created files: when a branch
  // creates a NEW file (no baseline) and is then discarded, the file
  // must be removed from BOTH disk and the gate's in-memory live map.
  // Exercises the discardRunnerBranch contract end-to-end with the
  // `del` callback the runner now wires from auto-runner.
  it('removes branch-created files from disk on discard via the del callback', async () => {
    const host: RunnerBranchHost = { repairAudit: [], branchOpen: false };
    const disk = new Map<string, string>([['a.ts', 'export const x = 1;']]);
    const writeImpl = async (p: string, c: string) => { disk.set(p, c); };
    const delImpl = async (p: string) => { disk.delete(p); };

    const repairBranch = await import('../repair-branch');
    const branch = repairBranch.openRunnerRepairBranch(
      host,
      'verify-then-start',
      Array.from(disk.entries()).map(([path, content]) => ({ path, content })),
      1,
    );

    // Branch creates a NEW file (no baseline) and modifies an existing one.
    branch.files.set('created.ts', 'export const z = (');
    branch.touched.add('created.ts');
    await writeImpl('created.ts', 'export const z = (');
    branch.files.set('a.ts', 'export const x = 99;');
    branch.touched.add('a.ts');
    await writeImpl('a.ts', 'export const x = 99;');

    await repairBranch.discardRunnerBranch(
      host,
      branch,
      'simulated regression',
      writeImpl,
      { ok: false, errors: ['created.ts'] },
      delImpl,
    );

    // created.ts (no baseline) was deleted via del callback.
    expect(disk.has('created.ts')).toBe(false);
    // a.ts (with baseline) was restored to baseline contents.
    expect(disk.get('a.ts')).toBe('export const x = 1;');
    // Audit recorded the discard.
    const discarded = host.repairAudit!.filter(r => r.status === 'discarded');
    expect(discarded.length).toBe(1);
  });
});
