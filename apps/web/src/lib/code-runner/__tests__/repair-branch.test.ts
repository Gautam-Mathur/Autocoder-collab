import { describe, it, expect } from 'vitest';
import {
  openRunnerRepairBranch,
  commitRunnerBranch,
  discardRunnerBranch,
  stageBranchWrite,
  validateRunnerBranch,
  makeRunnerNoRegressionValidator,
  summarizeRunnerRepairAudit,
  assertNoDirectWrite,
  type RunnerBranchHost,
  type RunnerBranchFile,
} from '../repair-branch';

function makeHost(): RunnerBranchHost {
  return {};
}

function makeDisk(initial: Record<string, string>) {
  const disk = new Map(Object.entries(initial));
  return {
    disk,
    write: async (path: string, content: string) => {
      disk.set(path, content);
    },
  };
}

describe('runner repair-branch (Task #23)', () => {
  it('commits staged writes via the supplied write callback', async () => {
    const host = makeHost();
    const { disk, write } = makeDisk({ 'a.ts': 'A', 'b.ts': 'B' });
    const branch = openRunnerRepairBranch(host, 'parser-gate', [
      { path: 'a.ts', content: 'A' },
      { path: 'b.ts', content: 'B' },
    ], 1);
    stageBranchWrite(branch, 'a.ts', 'A2');
    const changed = await commitRunnerBranch(host, branch, write);
    expect(changed).toEqual(['a.ts']);
    expect(disk.get('a.ts')).toBe('A2');
    expect(disk.get('b.ts')).toBe('B');
    expect(host.repairAudit?.[0].status).toBe('committed');
  });

  it('discards a regressing branch and restores baseline on disk', async () => {
    const host = makeHost();
    const { disk, write } = makeDisk({ 'a.ts': 'A' });
    const branch = openRunnerRepairBranch(host, 'slm-repair', [
      { path: 'a.ts', content: 'A' },
    ], 1);
    // Simulate the SLM having already written to disk before validation.
    await write('a.ts', 'BROKEN');
    branch.files.set('a.ts', 'BROKEN');
    branch.touched.add('a.ts');
    await discardRunnerBranch(host, branch, 'rewrite parses dirty', write);
    expect(disk.get('a.ts')).toBe('A'); // restored
    expect(host.repairAudit?.[0]).toMatchObject({
      source: 'slm-repair',
      status: 'discarded',
      reason: 'rewrite parses dirty',
    });
  });

  it('rejects nested branches', () => {
    const host = makeHost();
    openRunnerRepairBranch(host, 'a', [], 1);
    expect(() => openRunnerRepairBranch(host, 'b', [], 1)).toThrow(/already open/);
  });

  it('makeRunnerNoRegressionValidator blocks new failures', async () => {
    const host = makeHost();
    const branch = openRunnerRepairBranch(host, 'slm-repair', [
      { path: 'a.ts', content: 'A' },
      { path: 'b.ts', content: 'BROKEN' },
    ], 1);
    branch.files.set('a.ts', 'BROKEN'); // regression!
    branch.touched.add('a.ts');
    const v = makeRunnerNoRegressionValidator(
      (files: RunnerBranchFile[]) =>
        new Set(files.filter((f) => f.content.includes('BROKEN')).map((f) => f.path)),
    );
    const result = await validateRunnerBranch(branch, v);
    expect(result.ok).toBe(false);
    expect(result.regressedFiles).toEqual(['a.ts']);
  });

  it('summarizeRunnerRepairAudit reports counts', async () => {
    const host = makeHost();
    const { write } = makeDisk({});
    const b1 = openRunnerRepairBranch(host, 'parser-gate', [], 1);
    await commitRunnerBranch(host, b1, write);
    const b2 = openRunnerRepairBranch(host, 'slm-repair', [], 1);
    await discardRunnerBranch(host, b2, 'r', write);
    expect(summarizeRunnerRepairAudit(host.repairAudit!)).toMatch(
      /2 repair attempts: 1 committed, 1 discarded/,
    );
  });

  it('assertNoDirectWrite is a no-op when no branch is open', () => {
    const host = makeHost();
    expect(() => assertNoDirectWrite(host, 'op')).not.toThrow();
  });

  // Task #23 — true snapshot parity: discarding a branch that CREATED a
  // file (no baseline) must remove the file, not leak it onto the FS.
  it('discardRunnerBranch removes files created during the branch when a del callback is supplied', async () => {
    const host = makeHost();
    const disk = new Map<string, string>([['existing.ts', 'baseline']]);
    const write = async (p: string, c: string) => { disk.set(p, c); };
    const del = async (p: string) => { disk.delete(p); };

    const branch = openRunnerRepairBranch(
      host,
      'slm-repair',
      Array.from(disk.entries()).map(([path, content]) => ({ path, content })),
      1,
    );
    // Modify existing + create new.
    stageBranchWrite(branch, 'existing.ts', 'mutated');
    await write('existing.ts', 'mutated');
    stageBranchWrite(branch, 'new-file.ts', 'created by branch');
    await write('new-file.ts', 'created by branch');

    await discardRunnerBranch(host, branch, 'simulated regression', write, undefined, del);

    expect(disk.get('existing.ts')).toBe('baseline');
    expect(disk.has('new-file.ts')).toBe(false);
  });
});
