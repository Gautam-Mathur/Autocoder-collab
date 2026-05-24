import { describe, it, expect, beforeEach } from 'vitest';
import {
  openRepairBranch,
  commitBranch,
  discardBranch,
  commitOrDiscard,
  validateBranch,
  assertNoDirectWrite,
  summarizeRepairAudit,
  ALWAYS_PASS_VALIDATOR,
  makeNoRegressionValidator,
  type RepairBranchHost,
} from '../repair-branch.js';
import type { GeneratedFile } from '../pipeline-orchestrator.js';

function host(initial: GeneratedFile[] = []): RepairBranchHost {
  return { files: initial.map((f) => ({ ...f })) };
}

const f = (path: string, content: string): GeneratedFile =>
  ({ path, content }) as GeneratedFile;

describe('repair-branch (Task #23)', () => {
  beforeEach(() => {
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
  });

  it('opens a branch, mutates copy, commits, and merges back into ctx.files', () => {
    const ctx = host([f('a.ts', 'A'), f('b.ts', 'B')]);
    const branch = openRepairBranch(ctx, 'parser-gate', 1);
    expect(ctx.branchOpen).toBe(true);
    branch.files[0] = { ...branch.files[0], content: 'A2' };
    branch.files.push(f('c.ts', 'C'));
    const r = commitBranch(ctx, branch);
    expect(r.merged).toBe(2);
    expect(r.filesChanged.sort()).toEqual(['a.ts', 'c.ts']);
    expect(ctx.files.find((x) => x.path === 'a.ts')?.content).toBe('A2');
    expect(ctx.files.find((x) => x.path === 'c.ts')?.content).toBe('C');
    expect(ctx.branchOpen).toBe(false);
    expect(ctx.repairAudit?.[0]).toMatchObject({
      source: 'parser-gate',
      attempt: 1,
      status: 'committed',
    });
  });

  it('discards a branch leaving ctx.files untouched', () => {
    const ctx = host([f('a.ts', 'A')]);
    const branch = openRepairBranch(ctx, 'slm-repair', 2);
    branch.files[0] = { ...branch.files[0], content: 'BAD' };
    discardBranch(ctx, branch, 'rewrite still parses dirty');
    expect(ctx.files[0].content).toBe('A');
    expect(ctx.repairAudit?.[0]).toMatchObject({
      source: 'slm-repair',
      attempt: 2,
      status: 'discarded',
      reason: 'rewrite still parses dirty',
    });
  });

  it('rejects nested branches', () => {
    const ctx = host([f('a.ts', 'A')]);
    openRepairBranch(ctx, 'outer', 1);
    expect(() => openRepairBranch(ctx, 'inner', 1)).toThrow(/already open/);
  });

  it('rejects double-commit and double-discard', () => {
    const ctx = host([f('a.ts', 'A')]);
    const b = openRepairBranch(ctx, 'x', 1);
    commitBranch(ctx, b);
    expect(() => commitBranch(ctx, b)).toThrow(/closed/);
    const ctx2 = host([f('a.ts', 'A')]);
    const b2 = openRepairBranch(ctx2, 'x', 1);
    discardBranch(ctx2, b2, 'r');
    expect(() => discardBranch(ctx2, b2, 'r')).toThrow(/closed/);
  });

  it('assertNoDirectWrite throws in dev when a branch is open', () => {
    const ctx = host([f('a.ts', 'A')]);
    openRepairBranch(ctx, 'x', 1);
    process.env.NODE_ENV = 'development';
    expect(() => assertNoDirectWrite(ctx, 'enqueueFileSnapshot')).toThrow(
      /Direct write/,
    );
  });

  it('assertNoDirectWrite is a no-op when no branch is open', () => {
    const ctx = host([f('a.ts', 'A')]);
    expect(() => assertNoDirectWrite(ctx, 'op')).not.toThrow();
  });

  it('commitOrDiscard commits when validator passes and discards when it fails', async () => {
    const ctx = host([f('a.ts', 'A')]);
    const b1 = openRepairBranch(ctx, 'parser-gate', 1);
    b1.files[0] = { ...b1.files[0], content: 'A2' };
    const ok = await commitOrDiscard(ctx, b1, ALWAYS_PASS_VALIDATOR);
    expect(ok).toBe(true);
    expect(ctx.files[0].content).toBe('A2');

    const b2 = openRepairBranch(ctx, 'slm-repair', 1);
    b2.files[0] = { ...b2.files[0], content: 'BAD' };
    const failed = await commitOrDiscard(ctx, b2, () => ({
      ok: false,
      errors: ['a.ts'],
      regressedFiles: ['a.ts'],
    }));
    expect(failed).toBe(false);
    expect(ctx.files[0].content).toBe('A2'); // not BAD
  });

  it('makeNoRegressionValidator blocks regressions and allows shrinking error set', async () => {
    const errs = (files: GeneratedFile[]) =>
      new Set(files.filter((f) => f.content.includes('BROKEN')).map((f) => f.path));
    const v = makeNoRegressionValidator(errs);

    const ctx = host([f('a.ts', 'A'), f('b.ts', 'BROKEN')]);
    const branch = openRepairBranch(ctx, 'slm-repair', 1);
    branch.files[1] = { ...branch.files[1], content: 'fixed' };
    const ok = await validateBranch(branch, v);
    expect(ok.ok).toBe(true);
    expect(ok.errors.length).toBe(0);
    commitBranch(ctx, branch, { validation: ok });

    const branch2 = openRepairBranch(ctx, 'slm-repair', 2);
    branch2.files[0] = { ...branch2.files[0], content: 'BROKEN' };
    const bad = await validateBranch(branch2, v);
    expect(bad.ok).toBe(false);
    expect(bad.regressedFiles).toEqual(['a.ts']);
    discardBranch(ctx, branch2, 'regressed', { validation: bad });
  });

  it('summarizeRepairAudit produces a one-line rollup', () => {
    const ctx = host([f('a.ts', 'A')]);
    const b1 = openRepairBranch(ctx, 'parser-gate', 1);
    commitBranch(ctx, b1);
    const b2 = openRepairBranch(ctx, 'slm-repair', 1);
    discardBranch(ctx, b2, 'still parses dirty');
    const b3 = openRepairBranch(ctx, 'slm-repair', 2);
    commitBranch(ctx, b3);
    const summary = summarizeRepairAudit(ctx.repairAudit ?? []);
    expect(summary).toMatch(/3 repair attempts/);
    expect(summary).toMatch(/2 committed/);
    expect(summary).toMatch(/1 discarded/);
  });

  it('summarizeRepairAudit handles empty audit', () => {
    expect(summarizeRepairAudit([])).toMatch(/No repair attempts/);
  });

  // ── E2E-style: parser-gate commits, SLM-style attempt regresses and is
  //    discarded, parser-gate's commit is retained on ctx.files. ──
  it('per-attempt isolation: failed SLM attempt is discarded while prior parser-gate fix is retained', async () => {
    // Marker for "broken file" — validator counts files containing 'BROKEN'.
    const errs = (files: GeneratedFile[]) =>
      new Set(files.filter((f) => f.content.includes('BROKEN')).map((f) => f.path));
    const noRegression = makeNoRegressionValidator(errs);

    // Seed: A.tsx is broken, B.tsx is clean.
    const ctx = host([f('A.tsx', 'BROKEN A'), f('B.tsx', 'clean B')]);

    // Attempt 1 — parser-gate fixes A.tsx. No regression → commits.
    const parserGate = openRepairBranch(ctx, 'parser-gate', 1);
    parserGate.files[0] = { ...parserGate.files[0], content: 'parser-fixed A' };
    const ok1 = await commitOrDiscard(ctx, parserGate, noRegression);
    expect(ok1).toBe(true);
    expect(ctx.files[0].content).toBe('parser-fixed A');

    // Attempt 2 — SLM-style attempt: tries to "improve" A.tsx but breaks
    // B.tsx in the process (regression). Branch must be DISCARDED and
    // ctx.files must still reflect the parser-gate commit.
    const slm = openRepairBranch(ctx, 'slm-repair', 1);
    slm.files[0] = { ...slm.files[0], content: 'slm-rewrote A' };
    slm.files[1] = { ...slm.files[1], content: 'BROKEN B (regression)' };
    const ok2 = await commitOrDiscard(ctx, slm, noRegression);
    expect(ok2).toBe(false);
    // CRITICAL: parser-gate's fix is still there; SLM's edits did NOT leak.
    expect(ctx.files[0].content).toBe('parser-fixed A');
    expect(ctx.files[1].content).toBe('clean B');
    // Audit reflects both attempts with the right verdicts.
    const audit = ctx.repairAudit ?? [];
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ source: 'parser-gate', status: 'committed' });
    expect(audit[1]).toMatchObject({ source: 'slm-repair', status: 'discarded' });
    expect(audit[1].reason).toMatch(/regressed|validation failed/);

    // Attempt 3 — template-basement floor: even when something else has
    // gone wrong, the floor MUST be allowed to commit (ALWAYS_PASS_VALIDATOR).
    const basement = openRepairBranch(ctx, 'template-basement', 1);
    basement.files[0] = { ...basement.files[0], content: 'stub A' };
    const ok3 = await commitOrDiscard(ctx, basement, ALWAYS_PASS_VALIDATOR);
    expect(ok3).toBe(true);
    expect(ctx.files[0].content).toBe('stub A');
  });
});
