// slm-repair.ts — SLM-driven syntax repair primitive.
//
// Layer 2 of the three-layer cascade. Given a single ParseError plus a
// bounded code window, ask the local LLM to return a corrected file. The
// caller (three-layer-cascade.ts) decides when to stop.
//
// Hard caps — never exceeded, regardless of LLM behaviour:
//   • 3 attempts per file
//   • 30 s wall time per file (across all attempts)
//   • 10 files per cascade pass
//
// Bounded context: we send only ±10 lines around the error, the file
// path, and the parser message — never the whole file. Two reasons:
//   (a) keeps prompt small enough for 7B models to handle reliably;
//   (b) reduces the blast-radius of a hallucinated rewrite.

import type { ParseError } from "./parser-gate";

export interface SlmRepairResult {
  /** True iff the LLM returned a non-empty replacement different from the original. */
  fixed: boolean;
  /** New file content if fixed, otherwise null. */
  content: string | null;
  /** Why this attempt didn't repair the file (empty string when fixed). */
  reason: string;
  /** How many attempts the SLM consumed for this file. */
  attempts: number;
  /** Total wall time spent on this file in ms. */
  elapsedMs: number;
}

export interface SlmRepairOptions {
  /** Max attempts per file. Default 3. Hard cap at 3. */
  maxAttempts?: number;
  /** Max wall time per file in ms. Default 30 000. Hard cap at 30 000. */
  perFileTimeoutMs?: number;
  /** Override the api-server base URL. Default reads VITE_API_BASE / falls back to localhost:3001. */
  apiBase?: string;
  /** Replace the network call (used by tests). */
  fetchFn?: typeof fetch;
}

const HARD_CAP_ATTEMPTS = 3;
const HARD_CAP_PER_FILE_MS = 30_000;
const HARD_CAP_FILES_PER_PASS = 10;

/**
 * Splice a replacement block back into the original file at the given
 * 1-based inclusive line range. Strips the "  17| " line-number prefix
 * that the parser-gate prepends so the model can see line numbers in
 * context but doesn't have to echo them back.
 */
export function spliceWindow(
  original: string,
  startLine: number,
  endLine: number,
  replacement: string,
): string {
  const lines = original.split("\n");
  if (startLine < 1 || endLine > lines.length || startLine > endLine) return original;
  const cleanedReplacement = replacement
    .split("\n")
    .map((l) => l.replace(/^[> ]\s*\d+\|\s?/, ""))
    .join("\n");
  const before = lines.slice(0, startLine - 1).join("\n");
  const after = lines.slice(endLine).join("\n");
  return [before, cleanedReplacement, after].filter((s) => s.length > 0).join("\n");
}

function defaultApiBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  // Empty string = relative URL = goes through the artifact's BASE_URL via
  // the Replit shared proxy, which routes /api/* to the api-server artifact
  // regardless of which host the browser sees. The previous default
  // `http://localhost:3001` pointed at the user's *own* machine when this
  // bundle ran in their browser, so every call ERR_CONNECTION_REFUSED'd
  // and slm-repair fell through to template-basement.
  // VITE_API_BASE remains an explicit escape hatch for self-hosting.
  const raw = env?.VITE_API_BASE ?? "";
  return raw.replace(/\/+$/, "");
}

/**
 * Repair a single file. Returns immediately on the first attempt that
 * yields a different file body; otherwise burns through up to
 * `maxAttempts` (capped at 3) before giving up.
 */
export async function repairFileWithSlm(
  file: { path: string; content: string },
  err: ParseError,
  options: SlmRepairOptions = {},
): Promise<SlmRepairResult> {
  const maxAttempts = Math.min(HARD_CAP_ATTEMPTS, Math.max(1, options.maxAttempts ?? 3));
  const perFileTimeout = Math.min(HARD_CAP_PER_FILE_MS, Math.max(1_000, options.perFileTimeoutMs ?? 30_000));
  const apiBase = (options.apiBase ?? defaultApiBase()).replace(/\/+$/, "");
  const fetchFn = options.fetchFn ?? fetch;
  const start = Date.now();
  let attempts = 0;
  let lastReason = "no attempts made";

  while (attempts < maxAttempts) {
    const remaining = perFileTimeout - (Date.now() - start);
    if (remaining <= 200) {
      lastReason = `per-file timeout (${perFileTimeout}ms) hit before attempt ${attempts + 1}`;
      break;
    }
    attempts++;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.min(remaining, perFileTimeout));
    try {
      // BOUNDED CONTEXT: send only the ±10 line window over the wire,
      // never the whole file. The SLM returns a corrected window block;
      // we splice it back into the original file by line range here.
      const resp = await fetchFn(`${apiBase}/api/repair/syntax`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: file.path,
          error: {
            line: err.line,
            column: err.column,
            message: err.message,
            reasonCode: err.reasonCode ?? null,
          },
          window: {
            text: err.windowText,
            start: err.windowStart,
            end: err.windowEnd,
          },
        }),
        signal: ctl.signal,
      });
      if (!resp.ok) {
        lastReason = `repair endpoint ${resp.status}`;
        continue;
      }
      const body = (await resp.json().catch(() => null)) as
        | { window?: string; reason?: string }
        | null;
      const replacementWindow = body?.window;
      if (typeof replacementWindow === "string" && replacementWindow.length > 0) {
        const next = spliceWindow(
          file.content,
          err.windowStart,
          err.windowEnd,
          replacementWindow,
        );
        if (next !== file.content) {
          return {
            fixed: true,
            content: next,
            reason: "",
            attempts,
            elapsedMs: Date.now() - start,
          };
        }
        lastReason = "SLM window matched original — no change";
      } else {
        lastReason = body?.reason || "SLM returned no window";
      }
    } catch (e) {
      lastReason = `attempt ${attempts} failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      clearTimeout(t);
    }
  }

  return {
    fixed: false,
    content: null,
    reason: lastReason,
    attempts,
    elapsedMs: Date.now() - start,
  };
}

/**
 * Repair a batch of files, capped at 10 per pass (hard limit). Returns a
 * map keyed by file path with the result of each attempt. Files beyond
 * the cap are reported as `skipped-cap`.
 */
export async function repairBatchWithSlm(
  files: { path: string; content: string }[],
  errors: ParseError[],
  options: SlmRepairOptions & { deadline?: number } = {},
): Promise<Map<string, SlmRepairResult>> {
  const out = new Map<string, SlmRepairResult>();
  const errByFile = new Map<string, ParseError>();
  for (const e of errors) if (!errByFile.has(e.file)) errByFile.set(e.file, e);

  const eligible = files.filter((f) => errByFile.has(f.path));
  const capped = eligible.slice(0, HARD_CAP_FILES_PER_PASS);
  const skipped = eligible.slice(HARD_CAP_FILES_PER_PASS);
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;

  for (const f of capped) {
    if (Date.now() >= deadline) {
      out.set(f.path, {
        fixed: false,
        content: null,
        reason: "gate-pass budget exhausted before file processed",
        attempts: 0,
        elapsedMs: 0,
      });
      continue;
    }
    const err = errByFile.get(f.path)!;
    // Cap per-file timeout by remaining gate budget — never exceed it.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      out.set(f.path, {
        fixed: false,
        content: null,
        reason: "gate-pass deadline reached",
        attempts: 0,
        elapsedMs: 0,
      });
      continue;
    }
    const r = await repairFileWithSlm(f, err, {
      ...options,
      perFileTimeoutMs: Math.min(options.perFileTimeoutMs ?? 30_000, remaining),
    });
    out.set(f.path, r);
  }
  for (const f of skipped) {
    out.set(f.path, {
      fixed: false,
      content: null,
      reason: `skipped-cap: more than ${HARD_CAP_FILES_PER_PASS} files in one pass`,
      attempts: 0,
      elapsedMs: 0,
    });
  }
  return out;
}

export const SLM_HARD_CAPS = {
  attempts: HARD_CAP_ATTEMPTS,
  perFileMs: HARD_CAP_PER_FILE_MS,
  filesPerPass: HARD_CAP_FILES_PER_PASS,
} as const;
