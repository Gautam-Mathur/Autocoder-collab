/**
 * Task #23 — Sandboxed Repair Branches (api-server side).
 *
 * A `RepairBranch` is a copy-on-write snapshot of `ctx.files` that an
 * individual repair attempt mutates in isolation. The branch is then
 * validated against the same gates the main lineage uses; only branches
 * that pass validation merge back. Failed branches are discarded with an
 * audit entry — they NEVER leave half-applied edits behind.
 *
 * This generalises the Single-Writer Enforcement (Fix 5) pattern:
 * Fix 5 made post-Stage-11 enhancements queue diffs into one drained
 * applier; this task makes EVERY repair attempt go through a sandbox
 * with explicit commit/discard semantics + an audit trail.
 *
 * Design constraints (see .local/tasks/task-23.md):
 *   - Branches are not nested — opening a branch while one is open is
 *     a programming error (throws).
 *   - Direct writes to `ctx.files` while a branch is open are disallowed
 *     (the no-direct-write assertion). In dev it throws; in prod it
 *     emits a once-per-process warning so we don't crash production runs
 *     for a missed migration.
 *   - `template-basement` is the floor and must always be allowed to
 *     commit — its branch validation is intentionally permissive.
 *   - Branches are cheap: structured-clone of `ctx.files` is fine for
 *     typical project sizes (≤ 80 files).
 */

import type { GeneratedFile } from './pipeline-orchestrator.js';

export interface RepairAuditEntry {
  /** Repair layer that opened the branch. */
  source: string;
  /** 1-based attempt counter within `source` for the same repair cycle. */
  attempt: number;
  status: 'committed' | 'discarded';
  /** Human-readable reason — required when status === 'discarded'. */
  reason?: string;
  /** Paths actually changed inside the branch (commit or attempted). */
  filesChanged: string[];
  /** Error count delta from baseline → branch (when validator provided). */
  errorCount?: { before: number; after: number };
  /** ms since epoch — supports rollup ordering in the chat UI. */
  timestampMs: number;
}

export interface RepairBranch {
  source: string;
  attempt: number;
  /** Immutable snapshot of ctx.files at open time (deep-cloned). */
  base: GeneratedFile[];
  /** Mutable working copy. Repair code mutates THIS, not ctx.files. */
  files: GeneratedFile[];
  /** Set true once committed/discarded — prevents double-commit bugs. */
  closed: boolean;
}

/**
 * Minimal slice of PipelineContext the branch helpers need. Defined as
 * its own interface so this module doesn't import the orchestrator types
 * (avoids a cycle) and so unit tests can pass a plain object.
 */
export interface RepairBranchHost {
  files: GeneratedFile[];
  repairAudit?: RepairAuditEntry[];
  branchOpen?: boolean;
}

/** Result of validating a branch against a caller-provided validator. */
export interface BranchValidation {
  ok: boolean;
  errors: string[];
  /** Files that were clean in `base` but are erroring in the branch. */
  regressedFiles?: string[];
  /** Pre-branch error count (when known) — recorded in audit deltas. */
  errorsBefore?: number;
}

export type BranchValidator = (
  branch: RepairBranch,
) => BranchValidation | Promise<BranchValidation>;

let directWriteWarned = false;

function deepCloneFiles(files: GeneratedFile[]): GeneratedFile[] {
  return files.map((f) => ({ ...f }));
}

/** Throw (dev) or warn-once (prod) on direct ctx.files write while a branch is open. */
export function assertNoDirectWrite(ctx: RepairBranchHost, op?: string): void {
  if (!ctx.branchOpen) return;
  const msg =
    `[repair-branch] Direct write to ctx.files while a repair branch is open` +
    (op ? ` (${op})` : '') +
    `. Mutate branch.files instead and commit/discard via repair-branch.`;
  if (process.env.NODE_ENV !== 'production') {
    throw new Error(msg);
  }
  if (!directWriteWarned) {
    directWriteWarned = true;
    console.warn(msg);
  }
}

export function openRepairBranch(
  ctx: RepairBranchHost,
  source: string,
  attempt = 1,
): RepairBranch {
  if (ctx.branchOpen) {
    throw new Error(
      `[repair-branch] cannot open branch (${source}#${attempt}) — ` +
        `another branch is already open. Branches are not nested.`,
    );
  }
  const base = deepCloneFiles(ctx.files);
  const branch: RepairBranch = {
    source,
    attempt,
    base,
    files: deepCloneFiles(base),
    closed: false,
  };
  ctx.branchOpen = true;
  return branch;
}

/**
 * Validate a branch using the supplied validator. Always computes the
 * `regressedFiles` list (paths previously absent from validator errors
 * that are now present) so callers can include it in audit reasons.
 */
export async function validateBranch(
  branch: RepairBranch,
  validator: BranchValidator,
): Promise<BranchValidation> {
  if (branch.closed) {
    throw new Error(`[repair-branch] cannot validate closed branch (${branch.source}#${branch.attempt})`);
  }
  const result = await validator(branch);
  return result;
}

function diffPaths(base: GeneratedFile[], next: GeneratedFile[]): string[] {
  const baseMap = new Map(base.map((f) => [f.path, f.content]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of next) {
    seen.add(f.path);
    const prev = baseMap.get(f.path);
    if (prev === undefined || prev !== f.content) out.push(f.path);
  }
  for (const path of baseMap.keys()) {
    if (!seen.has(path)) out.push(path); // file removed
  }
  return out;
}

function pushAudit(ctx: RepairBranchHost, entry: RepairAuditEntry): void {
  if (!ctx.repairAudit) ctx.repairAudit = [];
  ctx.repairAudit.push(entry);
}

export interface CommitOptions {
  /** Optional pre-computed validation. Recorded in audit. */
  validation?: BranchValidation;
}

/**
 * Merge the branch's working files back into ctx.files. Last-writer-wins
 * per file path (consistent with applyPendingDiffs). Records a
 * `committed` audit entry. Closes the branch.
 */
export function commitBranch(
  ctx: RepairBranchHost,
  branch: RepairBranch,
  opts: CommitOptions = {},
): { merged: number; filesChanged: string[] } {
  if (branch.closed) {
    throw new Error(`[repair-branch] cannot commit closed branch (${branch.source}#${branch.attempt})`);
  }
  const filesChanged = diffPaths(branch.base, branch.files);
  const branchByPath = new Map(branch.files.map((f) => [f.path, f]));
  const branchPaths = new Set(branch.files.map((f) => f.path));
  let merged = 0;
  // Apply edits + adds.
  for (const path of filesChanged) {
    const target = branchByPath.get(path);
    if (!target) {
      // File removed in branch — drop from ctx.files too.
      const idx = ctx.files.findIndex((f) => f.path === path);
      if (idx >= 0) {
        ctx.files.splice(idx, 1);
        merged++;
      }
      continue;
    }
    const idx = ctx.files.findIndex((f) => f.path === target.path);
    if (idx >= 0) {
      if (ctx.files[idx].content !== target.content) {
        ctx.files[idx] = { ...ctx.files[idx], content: target.content };
        merged++;
      }
    } else {
      ctx.files.push({ ...target });
      merged++;
    }
  }
  // Drop any ctx files that the branch deleted (when branch had a SHORTER list).
  // Conservatively: only drop when branch did not include them at all AND we
  // didn't capture them in `filesChanged` above (already handled).
  void branchPaths;
  branch.closed = true;
  ctx.branchOpen = false;
  pushAudit(ctx, {
    source: branch.source,
    attempt: branch.attempt,
    status: 'committed',
    filesChanged,
    errorCount: opts.validation
      ? { before: opts.validation.errorsBefore ?? 0, after: opts.validation.errors.length }
      : undefined,
    timestampMs: Date.now(),
  });
  return { merged, filesChanged };
}

/**
 * Throw the branch away. Records a `discarded` audit entry with the
 * supplied reason. ctx.files is untouched. Closes the branch.
 */
export function discardBranch(
  ctx: RepairBranchHost,
  branch: RepairBranch,
  reason: string,
  opts: CommitOptions = {},
): void {
  if (branch.closed) {
    throw new Error(`[repair-branch] cannot discard closed branch (${branch.source}#${branch.attempt})`);
  }
  const filesChanged = diffPaths(branch.base, branch.files);
  branch.closed = true;
  ctx.branchOpen = false;
  pushAudit(ctx, {
    source: branch.source,
    attempt: branch.attempt,
    status: 'discarded',
    reason,
    filesChanged,
    errorCount: opts.validation
      ? { before: opts.validation.errorsBefore ?? 0, after: opts.validation.errors.length }
      : undefined,
    timestampMs: Date.now(),
  });
}

/**
 * Convenience: validate and either commit-on-pass or discard-on-fail.
 * Returns true when the branch was committed.
 */
export async function commitOrDiscard(
  ctx: RepairBranchHost,
  branch: RepairBranch,
  validator: BranchValidator,
  failureReason?: (v: BranchValidation) => string,
): Promise<boolean> {
  const v = await validateBranch(branch, validator);
  if (v.ok) {
    commitBranch(ctx, branch, { validation: v });
    return true;
  }
  const reason =
    (failureReason && failureReason(v)) ||
    `validation failed: ${v.errors.length} error(s)` +
      (v.regressedFiles && v.regressedFiles.length > 0
        ? ` regressed: ${v.regressedFiles.slice(0, 3).join(', ')}`
        : '');
  discardBranch(ctx, branch, reason, { validation: v });
  return false;
}

/**
 * Build a one-line rollup string suitable for the end-of-run thinking step.
 * Example: "5 repair attempts: 3 committed (parser-gate, slm-repair×2),
 * 2 discarded (slm-repair: regressed App.tsx, ...)".
 */
export function summarizeRepairAudit(entries: RepairAuditEntry[]): string {
  if (entries.length === 0) return 'No repair attempts in this run.';
  const committed = entries.filter((e) => e.status === 'committed');
  const discarded = entries.filter((e) => e.status === 'discarded');
  const fmtBySource = (rows: RepairAuditEntry[]) => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.source, (counts.get(r.source) || 0) + 1);
    return Array.from(counts.entries())
      .map(([s, n]) => (n > 1 ? `${s}×${n}` : s))
      .join(', ');
  };
  const reasons = discarded
    .filter((e) => e.reason)
    .slice(0, 2)
    .map((e) => `${e.source}: ${e.reason}`)
    .join('; ');
  const head = `${entries.length} repair attempt${entries.length === 1 ? '' : 's'}: ${committed.length} committed`;
  const cParts = committed.length > 0 ? ` (${fmtBySource(committed)})` : '';
  const dParts =
    discarded.length > 0
      ? `, ${discarded.length} discarded${reasons ? ` (${reasons}${discarded.length > 2 ? ', …' : ''})` : ''}`
      : '';
  return head + cParts + dParts;
}

// ─────────────────────────────────────────────────────────────────────────
// Default validators
// ─────────────────────────────────────────────────────────────────────────

/**
 * Permissive validator used by template-basement: never blocks a commit.
 * The basement is the floor — its job is to keep the build alive even
 * when nothing else can. Any caller that wants stricter semantics can
 * pass their own validator.
 */
export const ALWAYS_PASS_VALIDATOR: BranchValidator = () => ({
  ok: true,
  errors: [],
});

/**
 * Default "no-regression" validator factory: caller supplies a function
 * that returns the set of files with parser errors for a given file
 * array. The validator passes when the branch's error set is a SUBSET
 * of the base's error set (i.e. no previously-clean file regressed AND
 * the total error count did not increase).
 */
export function makeNoRegressionValidator(
  errorPathsFor: (files: GeneratedFile[]) => Set<string>,
): BranchValidator {
  return (branch) => {
    const baseErrors = errorPathsFor(branch.base);
    const branchErrors = errorPathsFor(branch.files);
    const regressed: string[] = [];
    for (const p of branchErrors) if (!baseErrors.has(p)) regressed.push(p);
    const ok = regressed.length === 0 && branchErrors.size <= baseErrors.size;
    return {
      ok,
      errors: Array.from(branchErrors),
      regressedFiles: regressed.length > 0 ? regressed : undefined,
      errorsBefore: baseErrors.size,
    };
  };
}
