// parser-gate.ts — Babel-based syntax detector with first-error prioritization
// and bounded code-window context for downstream SLM repair.
//
// Layer 1 of the three-layer debugger cascade:
//   1. parser-gate (this file)  — find syntactic faults
//   2. slm-repair               — workhorse repair via local LLM
//   3. template-basement        — last-resort minimal substitution
//
// Why Babel and not esbuild?  We already use esbuild-wasm in the
// verify-then-start gate; Babel offers richer error positions
// (line/column ranges + reasonCode) that we feed verbatim to the SLM.
// `@babel/parser` is already in the dependency closure transitively
// (see node_modules), so this adds zero deploy cost.

import * as babelParser from "@babel/parser";

export interface ParseError {
  file: string;
  line: number;
  column: number;
  message: string;
  reasonCode?: string;
  /** ±N line window around the offending position, with 1-based line numbers prefixed. */
  windowText: string;
  /** Inclusive 1-based line range covered by `windowText`. */
  windowStart: number;
  windowEnd: number;
}

export interface ParseFile {
  path: string;
  content: string;
}

const PARSEABLE_EXT = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/i;
const SKIP_PATH = /(?:^|\/)(?:node_modules|dist|build|\.next)\//;
const CONFIG_PATHS = /(?:^|\/)(?:vite|vitest|tailwind|postcss)\.config\.[mc]?[tj]sx?$/i;

export function isParseable(path: string): boolean {
  if (SKIP_PATH.test(path)) return false;
  if (CONFIG_PATHS.test(path)) return false; // doctor handles configs
  if (path.endsWith(".d.ts")) return false;
  return PARSEABLE_EXT.test(path);
}

const TS_EXT = /\.(?:tsx?|mts|cts)$/i;
const JSX_EXT = /\.(?:tsx|jsx)$/i;

function parseSingle(file: ParseFile): ParseError | null {
  const isTs = TS_EXT.test(file.path);
  const isJsx = JSX_EXT.test(file.path);
  const plugins: babelParser.ParserPlugin[] = [];
  if (isTs) plugins.push("typescript");
  if (isJsx) plugins.push("jsx");
  plugins.push("decorators-legacy", "classProperties", "topLevelAwait");

  try {
    babelParser.parse(file.content, {
      sourceType: "module",
      sourceFilename: file.path,
      errorRecovery: false,
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      plugins,
    });
    return null;
  } catch (err) {
    // Babel throws a SyntaxError-like object with .loc and .reasonCode.
    const e = err as {
      message?: string;
      loc?: { line: number; column: number };
      reasonCode?: string;
    };
    const line = e.loc?.line ?? 1;
    const column = e.loc?.column ?? 0;
    const msg = e.message ?? String(err);
    const window = makeWindow(file.content, line, 10);
    return {
      file: file.path,
      line,
      column,
      message: msg,
      reasonCode: e.reasonCode,
      windowText: window.text,
      windowStart: window.start,
      windowEnd: window.end,
    };
  }
}

/**
 * Build a ±N-line window with 1-based line numbers prefixed (e.g. "  17| code").
 * Used as bounded context for the SLM-repair prompt. Capped to keep token use small.
 */
export function makeWindow(
  source: string,
  centerLine: number,
  radius: number,
): { text: string; start: number; end: number } {
  const lines = source.split("\n");
  const start = Math.max(1, centerLine - radius);
  const end = Math.min(lines.length, centerLine + radius);
  const width = String(end).length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const num = String(i).padStart(width, " ");
    const marker = i === centerLine ? ">" : " ";
    out.push(`${marker}${num}| ${lines[i - 1] ?? ""}`);
  }
  return { text: out.join("\n"), start, end };
}

/**
 * Run parser-gate over a file set. Returns at most one error per file
 * (the first one Babel reports), so the SLM-repair layer never wastes
 * iteration budget chasing cascade errors that disappear once the
 * primary fault is fixed.
 *
 * Hard cap: caller can limit how many files we report per pass via
 * `maxFiles` (default 10) so a corrupted dump can't fan out infinitely.
 */
export interface ParseGateOptions {
  /** Max files to report errors for in one pass. Default 10. */
  maxFiles?: number;
}

export function runParserGate(
  files: ParseFile[],
  options: ParseGateOptions = {},
): ParseError[] {
  const cap = Math.max(1, Math.min(50, options.maxFiles ?? 10));
  const out: ParseError[] = [];
  for (const f of files) {
    if (!isParseable(f.path)) continue;
    const err = parseSingle(f);
    if (err) {
      out.push(err);
      if (out.length >= cap) break;
    }
  }
  return out;
}
