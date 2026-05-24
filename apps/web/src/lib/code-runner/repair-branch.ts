// Task #23 — Sandboxed Repair Branches (runner side, in-browser).
//
// Mirror of the api-server's `repair-branch.ts` but adapted for the
// WebContainer FS: branches snapshot file contents in-memory at open
// time and, on discard, re-write the snapshot back to disk so the
// failed repair leaves NO half-applied edits behind.
//
// See `.local/tasks/task-23.md`. The api-server branch operates on
// `ctx.files` (in-memory array); this runner branch operates on a live
// FS bridge supplied by the caller (read/write callbacks).

export interface RepairAuditEntry {
  source: string;
  attempt: number;
  status: 'committed' | 'discarded';
  reason?: string;
  filesChanged: string[];
  errorCount?: { before: number; after: number };
  timestampMs: number;
}

export interface RunnerBranchFile {
  path: string;
  content: string;
}

export interface RunnerRepairBranch {
  source: string;
  attempt: number;
  /** Snapshot of file contents at open time (path → content). */
  baseline: Map<string, string>;
  /** Live working copy mutated by repair code. */
  files: Map<string, string>;
  /** Files that the branch wrote to (for restore on discard). */
  touched: Set<string>;
  closed: boolean;
}

export interface RunnerBranchHost {
  repairAudit?: RepairAuditEntry[];
  branchOpen?: boolean;
}

export interface RunnerBranchValidation {
  ok: boolean;
  errors: string[];
  regressedFiles?: string[];
}

export type RunnerBranchValidator = (
  branch: RunnerRepairBranch,
) => RunnerBranchValidation | Promise<RunnerBranchValidation>;

let directWriteWarned = false;

export function assertNoDirectWrite(host: RunnerBranchHost, op?: string): void {
  if (!host.branchOpen) return;
  const msg =
    `[repair-branch] direct write while a repair branch is open` +
    (op ? ` (${op})` : '') +
    `. Use the active branch's write callback instead.`;
  // Runner code runs in the browser; treat anything other than
  // production as dev for the throwing semantics. Vite injects
  // import.meta.env.PROD in production builds.
  const isProd =
    typeof import.meta !== 'undefined' &&
    !!(import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD;
  if (!isProd) {
    throw new Error(msg);
  }
  if (!directWriteWarned) {
    directWriteWarned = true;
    // eslint-disable-next-line no-console
    console.warn(msg);
  }
}

export function openRunnerRepairBranch(
  host: RunnerBranchHost,
  source: string,
  initial: RunnerBranchFile[] | Map<string, string>,
  attempt = 1,
): RunnerRepairBranch {
  if (host.branchOpen) {
    throw new Error(
      `[repair-branch] cannot open branch (${source}#${attempt}) — another branch is already open. Branches are not nested.`,
    );
  }
  const baseline = new Map<string, string>();
  if (initial instanceof Map) {
    for (const [k, v] of initial.entries()) baseline.set(k, v);
  } else {
    for (const f of initial) baseline.set(f.path, f.content);
  }
  const files = new Map(baseline);
  host.branchOpen = true;
  return {
    source,
    attempt,
    baseline,
    files,
    touched: new Set<string>(),
    closed: false,
  };
}

/**
 * Stage a write inside a branch — caller must funnel ALL repair writes
 * through this so the branch can revert on discard. Returns true if the
 * content actually changed.
 */
export function stageBranchWrite(
  branch: RunnerRepairBranch,
  path: string,
  content: string,
): boolean {
  if (branch.closed) {
    throw new Error(`[repair-branch] cannot write to closed branch (${branch.source}#${branch.attempt})`);
  }
  const prev = branch.files.get(path);
  if (prev === content) return false;
  branch.files.set(path, content);
  branch.touched.add(path);
  return true;
}

function diffPaths(branch: RunnerRepairBranch): string[] {
  const out: string[] = [];
  for (const path of branch.touched) {
    const before = branch.baseline.get(path);
    const after = branch.files.get(path);
    if (before !== after) out.push(path);
  }
  return out;
}

function pushAudit(host: RunnerBranchHost, entry: RepairAuditEntry): void {
  if (!host.repairAudit) host.repairAudit = [];
  host.repairAudit.push(entry);
}

/**
 * Commit the branch: flushes touched-and-changed files to disk via the
 * supplied write callback. Returns the list of paths actually written.
 */
export async function commitRunnerBranch(
  host: RunnerBranchHost,
  branch: RunnerRepairBranch,
  write: (path: string, content: string) => Promise<void>,
  validation?: RunnerBranchValidation,
): Promise<string[]> {
  if (branch.closed) {
    throw new Error(`[repair-branch] cannot commit closed branch (${branch.source}#${branch.attempt})`);
  }
  const filesChanged = diffPaths(branch);
  for (const path of filesChanged) {
    const content = branch.files.get(path);
    if (content === undefined) continue;
    try {
      await write(path, content);
    } catch (err) {
      // Don't break the pipeline — log and continue committing the rest.
      // eslint-disable-next-line no-console
      console.warn(`[repair-branch] commit write failed for ${path}:`, err);
    }
  }
  branch.closed = true;
  host.branchOpen = false;
  pushAudit(host, {
    source: branch.source,
    attempt: branch.attempt,
    status: 'committed',
    filesChanged,
    errorCount: validation
      ? { before: 0, after: validation.errors.length }
      : undefined,
    timestampMs: Date.now(),
  });
  return filesChanged;
}

/**
 * Discard the branch: restores any files the branch wrote back to their
 * baseline content (so the FS is identical to pre-open state). Records
 * a `discarded` audit entry.
 */
export async function discardRunnerBranch(
  host: RunnerBranchHost,
  branch: RunnerRepairBranch,
  reason: string,
  write: (path: string, content: string) => Promise<void>,
  validation?: RunnerBranchValidation,
  /**
   * Optional FS-delete callback used to remove files that the branch
   * CREATED (no baseline entry). Without it, created files cannot be
   * removed and we fall back to writing an empty string + warn-once,
   * which preserves the "no leaked half-written content" guarantee for
   * existing files while flagging the gap to operators.
   */
  del?: (path: string) => Promise<void>,
): Promise<void> {
  if (branch.closed) {
    throw new Error(`[repair-branch] cannot discard closed branch (${branch.source}#${branch.attempt})`);
  }
  const filesChanged = diffPaths(branch);
  // Restore baseline content on disk for any file the branch may have
  // already written via its own bridging code. Files CREATED by the
  // branch (no baseline) get deleted via `del`, or zeroed-out + warned
  // when no `del` callback was supplied.
  for (const path of branch.touched) {
    const baseline = branch.baseline.get(path);
    if (baseline === undefined) {
      // Created-during-branch — must be removed for true snapshot parity.
      if (del) {
        try { await del(path); } catch { /* best-effort */ }
      } else {
        if (!directWriteWarned) {
          directWriteWarned = true;
          // eslint-disable-next-line no-console
          console.warn(
            `[repair-branch] discard could not remove created file '${path}' — ` +
              `no del() callback supplied. Wrote empty content as fallback.`,
          );
        }
        try { await write(path, ''); } catch { /* best-effort */ }
      }
      continue;
    }
    try {
      await write(path, baseline);
    } catch {
      /* best-effort restore — never throw from discard */
    }
  }
  branch.closed = true;
  host.branchOpen = false;
  pushAudit(host, {
    source: branch.source,
    attempt: branch.attempt,
    status: 'discarded',
    reason,
    filesChanged,
    errorCount: validation
      ? { before: 0, after: validation.errors.length }
      : undefined,
    timestampMs: Date.now(),
  });
}

export async function validateRunnerBranch(
  branch: RunnerRepairBranch,
  validator: RunnerBranchValidator,
): Promise<RunnerBranchValidation> {
  if (branch.closed) {
    throw new Error(`[repair-branch] cannot validate closed branch (${branch.source}#${branch.attempt})`);
  }
  return validator(branch);
}

export function summarizeRunnerRepairAudit(entries: RepairAuditEntry[]): string {
  if (entries.length === 0) return 'No repair attempts.';
  const committed = entries.filter((e) => e.status === 'committed').length;
  const discarded = entries.filter((e) => e.status === 'discarded').length;
  return `${entries.length} repair attempt${entries.length === 1 ? '' : 's'}: ${committed} committed, ${discarded} discarded`;
}

/**
 * Build a no-regression validator from a parser-error producer. The
 * branch passes when no previously-clean file is broken AND the total
 * error count does not increase.
 */
export function makeRunnerNoRegressionValidator(
  errorPathsFor: (files: RunnerBranchFile[]) => Promise<Set<string>> | Set<string>,
): RunnerBranchValidator {
  return async (branch) => {
    const toArr = (m: Map<string, string>): RunnerBranchFile[] =>
      Array.from(m.entries()).map(([path, content]) => ({ path, content }));
    const baseErrors = await errorPathsFor(toArr(branch.baseline));
    const branchErrors = await errorPathsFor(toArr(branch.files));
    const regressed: string[] = [];
    for (const p of branchErrors) if (!baseErrors.has(p)) regressed.push(p);
    const ok = regressed.length === 0 && branchErrors.size <= baseErrors.size;
    return {
      ok,
      errors: Array.from(branchErrors),
      regressedFiles: regressed.length > 0 ? regressed : undefined,
    };
  };
}
