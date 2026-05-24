// three-layer-cascade.ts — orchestrator for parser-gate → slm-repair → template-basement.
//
// Drop-in pre-stage that runs BEFORE the existing esbuild verify-then-start
// gate. Anything this layer can fix never reaches the regex treadmill. What
// it can't fix is left untouched, so the existing engine still gets its
// shot. That keeps the 145-test floor green while adding a generative
// upgrade path on top.

import { runParserGate, type ParseError, type ParseFile } from "./parser-gate";
import { repairBatchWithSlm, type SlmRepairOptions } from "./slm-repair";
import { generateStub } from "./template-basement";
import { decidePreservation } from "./template-basement-guard";
import {
  openRunnerRepairBranch,
  commitRunnerBranch,
  discardRunnerBranch,
  stageBranchWrite,
  type RunnerBranchHost,
} from "./repair-branch";

export type CascadeAction =
  | "clean"
  | "slm-repaired"
  | "template-substituted"
  | "still-broken";

/** Spec-named action surfaced to upstream gate-result diagnostics. */
export type PerFileAction =
  | "unchanged"
  | "fixed-by-rule"
  | "fixed-by-slm"
  | "recovered-from-scaffold";

export interface CascadeFileResult {
  path: string;
  action: CascadeAction;
  banner?: string;
  initialError?: ParseError;
  slmReason?: string;
  slmAttempts?: number;
}

export interface CascadeResult {
  ok: boolean;
  perFile: CascadeFileResult[];
  /** Spec contract: gate-result-shaped action map, path → PerFileAction. */
  perFileActions: Record<string, PerFileAction>;
  rewrittenPaths: string[];
  banners: { path: string; reason: string }[];
  /** True when the gate-pass total budget was exhausted. */
  budgetExhausted?: boolean;
}

export interface CascadeOptions extends SlmRepairOptions {
  disableSlm?: boolean;
  disableTemplateBasement?: boolean;
  write: (path: string, content: string) => Promise<void>;
  /**
   * Task #23 — optional FS delete callback. Forwarded to
   * discardRunnerBranch so paths CREATED inside a branch (no baseline)
   * are removed from disk on discard. Cascade phases currently only
   * mutate existing files, so this is mostly a future-proofing hook.
   */
  del?: (path: string) => Promise<void>;
  log?: (msg: string) => void;
  /** Total budget for one gate-pass (default 30s — spec hard cap). */
  gatePassBudgetMs?: number;
  /**
   * Task #23 — optional sandboxed-repair-branch host. When supplied, the
   * SLM-repair phase opens a branch per accepted rewrite and discards it
   * if the rewrite still fails parser-gate (the existing re-parse already
   * gates acceptance — the branch adds an audit entry per attempt).
   */
  branchHost?: RunnerBranchHost;
  /**
   * Optional lookup that returns the scaffold's known-good version of
   * a file. When available, the basement prefers it over the synthetic
   * stub (matches the "recovered-from-scaffold" contract).
   */
  scaffoldLookup?: (path: string) => string | null | undefined;
}

const noopLog = () => {};

/**
 * The deterministic floor: ≤5 high-confidence mechanical syntax
 * repairs that work without a model. The cascade runs these BEFORE
 * the SLM so model-free environments still get real repairs.
 */
function applyFloorRules(content: string): string {
  let out = content;
  // Mangled arrow: `(e) = />` → `(e) =>` and `(e) = > foo` → `(e) => foo`
  out = out.replace(/=\s*\/>/g, "=>");
  out = out.replace(/=\s+>\s*/g, "=> ");
  // Trailing junk after final closing brace at EOF (e.g. stray ``` or ;).
  out = out.replace(/(\}\s*)(?:`{3,}|;{2,})\s*$/m, "$1");
  return out;
}

/**
 * Run the cascade once. The caller decides whether to loop (e.g. inside
 * `runVerifyThenStartGate`). One pass:
 *   1. Parse every code file → first-error list
 *   2. Bounded SLM repair (capped 10 files / 3 attempts / 30s)
 *   3. Re-parse repaired files; remaining offenders go to template-basement
 *   4. Return per-file action map + banner list
 */
// ─────────────────────────────────────────────────────────────────────
// Module-scope helpers — exported for unit tests in
// `three-layer-cascade.test.ts`. Detect SLM-side network/availability
// failures so we can surface them honestly instead of letting the
// literal "Failed to fetch" string bleed into user-visible logs.
// ─────────────────────────────────────────────────────────────────────
export const SLM_UNAVAILABLE_PAT =
  /failed to fetch|fetch failed|networkerror|network error|econnrefused|enotfound|aborted|abort error|repair endpoint 5\d\d|repair endpoint 4\d\d|no model|service unavailable/i;

export function friendlySlmReasonImpl(raw: string | undefined): string {
  if (!raw) return 'syntax error';
  if (SLM_UNAVAILABLE_PAT.test(raw)) {
    return `slm-repair unavailable (${raw.replace(/^attempt \d+ failed:\s*/i, '')})`;
  }
  return raw;
}

export async function runThreeLayerCascade(
  files: ParseFile[],
  options: CascadeOptions,
): Promise<CascadeResult> {
  const log = options.log ?? noopLog;
  const gateStart = Date.now();
  const gateBudget = Math.min(options.gatePassBudgetMs ?? 30_000, 30_000);
  const budgetLeft = () => gateBudget - (Date.now() - gateStart);

  const errors = runParserGate(files);
  if (errors.length === 0) {
    const actions: Record<string, PerFileAction> = {};
    for (const f of files) actions[f.path] = "unchanged";
    return {
      ok: true,
      perFile: files.map((f) => ({ path: f.path, action: "clean" as const })),
      perFileActions: actions,
      rewrittenPaths: [],
      banners: [],
    };
  }
  log(`parser-gate: ${errors.length} file(s) with first-error reported`);

  const errByPath = new Map(errors.map((e) => [e.file, e]));
  const perFile = new Map<string, CascadeFileResult>();
  for (const f of files) {
    if (errByPath.has(f.path)) {
      perFile.set(f.path, {
        path: f.path,
        action: "still-broken",
        initialError: errByPath.get(f.path),
      });
    } else {
      perFile.set(f.path, { path: f.path, action: "clean" });
    }
  }

  const rewritten: string[] = [];
  const banners: { path: string; reason: string }[] = [];

  // Use module-scope helpers so they can be unit-tested in isolation.
  const friendlySlmReason = friendlySlmReasonImpl;

  // ── Layer 1.5: deterministic floor rules (model-free) ──────────────
  // Tiny set of high-confidence mechanical repairs that run BEFORE the
  // SLM so the floor still does real work when no model is available.
  const floorFixed = new Set<string>();
  let floorAttempt = 0;
  for (const f of files) {
    const err = errByPath.get(f.path);
    if (!err) continue;
    const fixed = applyFloorRules(f.content);
    if (fixed === f.content) continue;
    const recheck = runParserGate([{ path: f.path, content: fixed }]);
    // Task #23 — sandbox the floor-rule write per file.
    let branch: import('./repair-branch').RunnerRepairBranch | null = null;
    if (options.branchHost) {
      try {
        floorAttempt++;
        branch = openRunnerRepairBranch(
          options.branchHost,
          'parser-gate-floor',
          [{ path: f.path, content: f.content }],
          floorAttempt,
        );
      } catch { branch = null; }
    }
    if (recheck.length === 0) {
      // Task #23 — strict copy-on-write: stage the write inside the
      // branch and let commitRunnerBranch flush to disk. When no branch
      // host is supplied (legacy callers), fall back to a direct write.
      if (branch && options.branchHost) {
        try {
          stageBranchWrite(branch, f.path, fixed);
          await commitRunnerBranch(options.branchHost, branch, options.write,
            { ok: true, errors: [] });
        } catch { /* never block on branch helpers */ }
      } else {
        await options.write(f.path, fixed);
      }
      rewritten.push(f.path);
      const r = perFile.get(f.path);
      if (r) {
        r.action = "slm-repaired"; // re-tagged to "fixed-by-rule" in actions map below
        r.banner = `Floor rule fixed syntax error at line ${err.line}`;
      }
      floorFixed.add(f.path);
      errByPath.delete(f.path);
      log(`floor-rules: ✓ ${f.path}`);
    } else if (branch && options.branchHost) {
      try {
        await discardRunnerBranch(
          options.branchHost,
          branch,
          `floor-rule rewrite still fails parser-gate: ${recheck[0].message}`,
          options.write,
          { ok: false, errors: [recheck[0].message] },
          options.del,
        );
      } catch { /* noop */ }
    }
  }

  // ── Layer 2: SLM repair (bounded) ───────────────────────────────────
  let budgetExhausted = false;
  const stillErrors = errors.filter((e) => errByPath.has(e.file));
  if (!options.disableSlm && budgetLeft() > 0 && stillErrors.length > 0) {
    const filesToRepair = files.filter((f) => errByPath.has(f.path));
    log(`slm-repair: attempting ${Math.min(filesToRepair.length, 10)} file(s)`);
    const repairs = await repairBatchWithSlm(filesToRepair, stillErrors, {
      ...options,
      deadline: gateStart + gateBudget,
    });
    if (budgetLeft() <= 0) budgetExhausted = true;
    // Collect SLM-unavailable paths and emit ONE aggregate line per
    // pass instead of N per-file lines (review feedback: noisy).
    const slmUnavailablePaths: string[] = [];
    let slmAttempt = 0;
    for (const [path, r] of repairs) {
      const result = perFile.get(path);
      if (!result) continue;
      result.slmAttempts = r.attempts;
      result.slmReason = friendlySlmReason(r.reason);
      if (r.reason && SLM_UNAVAILABLE_PAT.test(r.reason)) {
        slmUnavailablePaths.push(path);
      }
      // Task #23 — open a per-file branch around each SLM rewrite attempt.
      // The existing re-parse below decides whether to accept; the branch
      // contributes the audit entry + crash-isolation.
      const baseFile = files.find((f) => f.path === path);
      let slmBranch: import('./repair-branch').RunnerRepairBranch | null = null;
      if (options.branchHost && baseFile) {
        try {
          slmAttempt++;
          slmBranch = openRunnerRepairBranch(
            options.branchHost,
            'slm-repair',
            [{ path, content: baseFile.content }],
            slmAttempt,
          );
        } catch { slmBranch = null; }
      }
      if (r.fixed && r.content) {
        // Re-parse the proposed fix in isolation; only accept if clean.
        const recheck = runParserGate([{ path, content: r.content }]);
        if (recheck.length === 0) {
          // Task #23 — strict copy-on-write: stage to branch + commit.
          if (slmBranch && options.branchHost) {
            try {
              stageBranchWrite(slmBranch, path, r.content);
              await commitRunnerBranch(options.branchHost, slmBranch, options.write,
                { ok: true, errors: [] });
            } catch { /* noop */ }
          } else {
            await options.write(path, r.content);
          }
          rewritten.push(path);
          result.action = "slm-repaired";
          result.banner = `SLM repaired syntax error at line ${result.initialError?.line}`;
          log(`slm-repair: ✓ ${path} (${r.attempts} attempt(s), ${r.elapsedMs}ms)`);
        } else {
          result.slmReason = `SLM rewrite still failed parser-gate: ${recheck[0].message}`;
          log(`slm-repair: ✗ ${path} — rewrite still parses dirty`);
          if (slmBranch && options.branchHost) {
            try {
              await discardRunnerBranch(
                options.branchHost, slmBranch,
                `SLM rewrite still fails parser-gate: ${recheck[0].message}`,
                options.write,
                { ok: false, errors: [recheck[0].message] },
                options.del,
              );
            } catch { /* noop */ }
          }
        }
      } else {
        log(`slm-repair: ✗ ${path} — ${r.reason}`);
        if (slmBranch && options.branchHost) {
          try {
            await discardRunnerBranch(
              options.branchHost, slmBranch,
              `SLM did not produce a fix: ${r.reason ?? 'unknown'}`,
              options.write,
              { ok: false, errors: [] },
              options.del,
            );
          } catch { /* noop */ }
        }
      }
    }
    // ONE aggregate line per pass for SLM-unavailable cases (review feedback).
    if (slmUnavailablePaths.length > 0) {
      const sample = slmUnavailablePaths.slice(0, 3).join(", ");
      const more = slmUnavailablePaths.length > 3 ? `, +${slmUnavailablePaths.length - 3} more` : "";
      log(`slm-repair: skipped ${slmUnavailablePaths.length} file(s) — no model available (${sample}${more}); falling through to template-basement`);
    }
  } else {
    log("slm-repair: disabled (no model configured) — falling through to template-basement");
  }

  // Track scaffold-recovered paths so we can emit the right action enum.
  const scaffoldRecovered = new Set<string>();

  // ── Layer 3: template-basement (floor) ──────────────────────────────
  if (!options.disableTemplateBasement) {
    let basementAttempt = 0;
    for (const result of perFile.values()) {
      if (result.action !== "still-broken") continue;
      const reason =
        result.slmReason ?? result.initialError?.message ?? "unknown syntax error";

      const baseFile = files.find((f) => f.path === result.path);
      let bBranch: import('./repair-branch').RunnerRepairBranch | null = null;
      if (options.branchHost && baseFile) {
        try {
          basementAttempt++;
          bBranch = openRunnerRepairBranch(
            options.branchHost,
            'template-basement',
            [{ path: result.path, content: baseFile.content }],
            basementAttempt,
          );
        } catch { bBranch = null; }
      }

      // Spec preference: substitute the scaffold's known-good version
      // first; only fall back to a synthetic stub when no mapping exists.
      const scaffoldContent = options.scaffoldLookup?.(result.path);
      if (typeof scaffoldContent === "string" && scaffoldContent.length > 0) {
        const recheck = runParserGate([
          { path: result.path, content: scaffoldContent },
        ]);
        if (recheck.length === 0) {
          // Task #23 — strict copy-on-write: stage + commit.
          if (bBranch && options.branchHost) {
            try {
              stageBranchWrite(bBranch, result.path, scaffoldContent);
              await commitRunnerBranch(options.branchHost, bBranch, options.write,
                { ok: true, errors: [] });
            } catch { /* noop */ }
          } else {
            await options.write(result.path, scaffoldContent);
          }
          rewritten.push(result.path);
          scaffoldRecovered.add(result.path);
          result.action = "template-substituted";
          result.banner = `Recovered from scaffold: ${reason}`;
          banners.push({ path: result.path, reason: `recovered-from-scaffold: ${reason}` });
          log(`template-basement: scaffold-recovered ${result.path}`);
          continue;
        }
        log(`template-basement: scaffold copy of ${result.path} also fails parser-gate — falling back to stub`);
      }

      const stub = generateStub(result.path, reason);
      if (stub.substituted) {
        // ── PreservationGuard ─────────────────────────────────────────
        // NEVER overwrite a substantial source file with a tiny stub.
        // If the original is >1 KB and the stub would shrink it below
        // 50%, write the stub to ${path}.broken instead and KEEP the
        // original on disk. Surface a hard error so the user sees it.
        const originalContent = baseFile?.content ?? null;
        const decision = decidePreservation(originalContent, stub, result.path);

        if (decision.action === "sidecar-only") {
          // Refuse the destructive overwrite. Write a sidecar diagnostic
          // file the user can diff against the preserved original.
          if (bBranch && options.branchHost) {
            try {
              stageBranchWrite(bBranch, decision.writePath, decision.writeContent);
              await commitRunnerBranch(options.branchHost, bBranch, options.write,
                { ok: true, errors: [] });
            } catch { /* noop */ }
          } else {
            await options.write(decision.writePath, decision.writeContent);
          }
          // The original file is intentionally NOT added to rewritten[];
          // its on-disk content is unchanged. The sidecar IS recorded so
          // upstream consumers can surface the .broken file in the chat.
          rewritten.push(decision.writePath);
          // Action stays "still-broken" so the spec-shaped perFileActions
          // map below records this file as "unchanged" (it really is —
          // we refused to touch it). The banner carries the user-facing
          // explanation.
          result.banner = `Preserved original — stub written to ${decision.writePath}`;
          banners.push({
            path: result.path,
            reason: `preservation-guard refused overwrite: ${decision.reason}. Diagnostic stub at ${decision.writePath}.`,
          });
          log(
            `template-basement: ⚠️  REFUSED to overwrite ${result.path} (${decision.originalBytes} B → ${decision.stubBytes} B); wrote ${decision.writePath} instead`,
          );
        } else {
          // Safe to overwrite (original was small/empty/throwaway).
          // Task #23 — strict copy-on-write: stage + commit (template-
          // basement is the always-pass last resort).
          if (bBranch && options.branchHost) {
            try {
              stageBranchWrite(bBranch, result.path, stub.content);
              await commitRunnerBranch(options.branchHost, bBranch, options.write,
                { ok: true, errors: [] });
            } catch { /* noop */ }
          } else {
            await options.write(result.path, stub.content);
          }
          rewritten.push(result.path);
          result.action = "template-substituted";
          result.banner = `Reset to ${stub.kind} stub: ${reason}`;
          banners.push({ path: result.path, reason });
          log(`template-basement: stubbed ${result.path} (${stub.kind}; ${decision.reason})`);
        }
      } else if (bBranch && options.branchHost) {
        try {
          await discardRunnerBranch(
            options.branchHost, bBranch,
            `template-basement could not stub ${result.path}`,
            options.write,
            { ok: false, errors: [] },
            options.del,
          );
        } catch { /* noop */ }
      }
    }
  }

  const remainingBroken = Array.from(perFile.values()).filter(
    (r) => r.action === "still-broken",
  );

  // Build the spec-shaped perFileActions map.
  const actions: Record<string, PerFileAction> = {};
  for (const f of files) actions[f.path] = "unchanged";
  for (const r of perFile.values()) {
    if (r.action === "slm-repaired") {
      actions[r.path] = floorFixed.has(r.path) ? "fixed-by-rule" : "fixed-by-slm";
    } else if (r.action === "template-substituted") {
      actions[r.path] = scaffoldRecovered.has(r.path)
        ? "recovered-from-scaffold"
        : "fixed-by-rule";
    }
  }

  return {
    ok: remainingBroken.length === 0,
    perFile: Array.from(perFile.values()),
    perFileActions: actions,
    rewrittenPaths: rewritten,
    banners,
    budgetExhausted,
  };
}
