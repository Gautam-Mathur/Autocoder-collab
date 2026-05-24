/**
 * Import Validation Gate
 *
 * Scans every generated source file for bare ES module specifiers and
 * `require('spec')` calls and cross-checks each one against the 606-package
 * dependency registry.
 *
 * Buckets every unique third-party import into:
 *   - valid       — exists in AVAILABLE_DEPS or DEV_DEPS, kept as-is
 *   - remappable  — scope (e.g. "@radix-ui/...") is known but the leaf is not.
 *                   Remapped to the closest known member of the scope when one
 *                   exists, otherwise demoted to remove.
 *   - remove      — completely unknown. The import line is commented out with
 *                   a self-documenting marker so downstream stages and human
 *                   readers can see what was stripped and why.
 *
 * Relative imports ("./x", "../x"), aliased internal imports ("@/x", "~/x"),
 * Node built-ins, and any specifier already starting with "node:" are skipped
 * — they are validated elsewhere (cross-file-validator for aliases, runtime
 * resolution for built-ins).
 *
 * This module has no AI dependency. It is pure regex + Set lookups so it runs
 * deterministically in well under 100 ms for typical project sizes.
 */

import { AVAILABLE_DEPS, DEV_DEPS, ALL_KNOWN_PACKAGES } from './dependency-registry.js';

export interface ValidatorFile {
  path: string;
  content: string;
  language?: string;
}

export interface ImportValidationResult {
  /** Specifiers found and confirmed to exist in the registry. */
  valid: Set<string>;
  /** Specifiers that were rewritten to a known sibling within the same scope. */
  remappable: Map<string, string>;
  /** Specifiers that could not be matched and were commented out. */
  removed: Set<string>;
  /** New file contents keyed by path; only files whose content changed are present. */
  patchedFiles: Map<string, string>;
  /** Per-file count summaries for diagnostics. */
  perFile: Array<{ path: string; checked: number; remapped: number; removed: number }>;
}

const NODE_BUILTINS = new Set<string>([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs',
  'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path',
  'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl',
  'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/** Aliased internal prefixes — handled by other validators. */
const INTERNAL_ALIAS_PREFIXES = ['@/', '~/', '#/', '@app/', '@components/', '@lib/', '@hooks/', '@utils/', '@/components', '@/lib', '@/hooks', '@/utils'];

/**
 * Returns the package root for a bare specifier, e.g.
 *   "react"                       -> "react"
 *   "react/jsx-runtime"           -> "react"
 *   "@radix-ui/react-slot"        -> "@radix-ui/react-slot"
 *   "@radix-ui/react-slot/inner"  -> "@radix-ui/react-slot"
 */
function packageRoot(spec: string): string {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    if (parts.length >= 2) return parts.slice(0, 2).join('/');
    return spec;
  }
  return spec.split('/')[0];
}

/** Returns the scope prefix for scoped packages (e.g. "@radix-ui"), or null. */
function scopeOf(spec: string): string | null {
  if (!spec.startsWith('@')) return null;
  const slash = spec.indexOf('/');
  if (slash === -1) return null;
  return spec.slice(0, slash);
}

function isInternalAlias(spec: string): boolean {
  return INTERNAL_ALIAS_PREFIXES.some(p => spec === p.replace(/\/$/, '') || spec.startsWith(p));
}

function shouldSkip(spec: string): boolean {
  if (!spec || spec.length === 0) return true;
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') return true;
  if (spec.startsWith('/')) return true; // absolute path — not a package
  if (spec.startsWith('node:')) return true;
  if (isInternalAlias(spec)) return true;
  if (NODE_BUILTINS.has(spec)) return true;
  if (spec.startsWith('http://') || spec.startsWith('https://')) return true;
  return false;
}

interface ImportLineMatch {
  /** The full source line (without trailing newline) that should be replaced if removed. */
  fullLine: string;
  /** The bare specifier extracted from the import. */
  spec: string;
  /** Char offset of the line start within the file content. */
  lineStart: number;
  /** Length of the line including any trailing semicolon but not the newline. */
  lineLength: number;
}

/**
 * Extracts every static import / re-export / require specifier from a file.
 *
 * Recognised forms:
 *   - import x from 'spec'
 *   - import { a, b } from 'spec'
 *   - import 'spec'
 *   - import * as x from 'spec'
 *   - export ... from 'spec'
 *   - export * from 'spec'
 *   - require('spec')
 *
 * Dynamic imports with non-literal arguments are intentionally skipped.
 */
function extractImports(content: string): ImportLineMatch[] {
  const matches: ImportLineMatch[] = [];

  // Match import / export ... from 'spec' OR side-effect import 'spec' OR require('spec') OR await import('spec')
  // We intentionally do NOT match if the spec is a template literal or expression — only single-quoted
  // and double-quoted string literals.
  const RE = /(?:^|[\s;])(?:import\s+[^'"]*?from\s+|import\s+|export\s+[^'"]*?from\s+|require\s*\(\s*|import\s*\(\s*)(['"])([^'"\n]+)\1\s*\)?/gm;

  let m: RegExpExecArray | null;
  while ((m = RE.exec(content)) !== null) {
    const spec = m[2];
    if (!spec || shouldSkip(spec)) continue;

    // Locate the start of the line containing the match
    const matchStart = m.index;
    let lineStart = content.lastIndexOf('\n', matchStart) + 1;
    // Use lineStart (not matchStart) as the search origin: when the regex's
    // leading `(?:^|[\s;])` consumed the trailing newline of the *previous*
    // line, matchStart points at that newline and indexOf would return it
    // immediately, collapsing the slice to empty.
    let lineEnd = content.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = content.length;
    const fullLine = content.slice(lineStart, lineEnd);

    matches.push({
      fullLine,
      spec,
      lineStart,
      lineLength: lineEnd - lineStart,
    });
  }
  return matches;
}

function findSiblingInScope(scope: string): string | null {
  for (const pkg of ALL_KNOWN_PACKAGES) {
    if (pkg.startsWith(scope + '/')) return pkg;
  }
  return null;
}

/**
 * Decides what to do with a specifier:
 *   - 'valid'             → keep
 *   - { remap: 'foo' }    → rewrite import to the new spec
 *   - 'remove'            → comment out the import line
 *
 * Returns the original root used as the lookup key.
 */
type Decision =
  | { kind: 'valid' }
  | { kind: 'remap'; to: string }
  | { kind: 'remove' };

function decide(spec: string): Decision {
  const root = packageRoot(spec);
  if (ALL_KNOWN_PACKAGES.has(root)) return { kind: 'valid' };

  const scope = scopeOf(spec);
  if (scope) {
    const sibling = findSiblingInScope(scope);
    if (sibling) {
      // Preserve sub-path if the original had one
      const sub = spec.slice(root.length); // includes leading '/' or empty
      const remapped = sub ? sibling + sub : sibling;
      return { kind: 'remap', to: remapped };
    }
  }
  return { kind: 'remove' };
}

/**
 * Validates and patches every file. Returns a result describing what changed.
 * The original `files` array is not mutated; callers should apply `patchedFiles`
 * back onto their context.
 */
export function validateImports(files: ValidatorFile[]): ImportValidationResult {
  const valid = new Set<string>();
  const remappable = new Map<string, string>();
  const removed = new Set<string>();
  const patchedFiles = new Map<string, string>();
  const perFile: ImportValidationResult['perFile'] = [];

  for (const file of files) {
    if (!file.content || file.content.length === 0) continue;
    if (!isCodeFile(file.path)) continue;

    const matches = extractImports(file.content);
    if (matches.length === 0) {
      perFile.push({ path: file.path, checked: 0, remapped: 0, removed: 0 });
      continue;
    }

    // Build a list of edits sorted by descending lineStart so applying them
    // back-to-front does not invalidate offsets.
    const edits: Array<{ start: number; end: number; replacement: string }> = [];
    let remappedCount = 0;
    let removedCount = 0;

    for (const m of matches) {
      const decision = decide(m.spec);
      if (decision.kind === 'valid') {
        valid.add(packageRoot(m.spec));
        continue;
      }
      if (decision.kind === 'remap') {
        remappable.set(m.spec, decision.to);
        remappedCount++;
        const newLine = m.fullLine.replace(
          new RegExp(`(['"])${escapeRegex(m.spec)}\\1`),
          `$1${decision.to}$1`
        );
        edits.push({ start: m.lineStart, end: m.lineStart + m.lineLength, replacement: newLine });
        valid.add(packageRoot(decision.to));
        continue;
      }
      // remove
      removed.add(m.spec);
      removedCount++;
      const stripped = `// [AutoCoder] removed unknown import: '${m.spec}'`;
      edits.push({ start: m.lineStart, end: m.lineStart + m.lineLength, replacement: stripped });
    }

    if (edits.length === 0) {
      perFile.push({ path: file.path, checked: matches.length, remapped: 0, removed: 0 });
      continue;
    }

    // Apply edits back-to-front
    edits.sort((a, b) => b.start - a.start);
    let next = file.content;
    for (const e of edits) {
      next = next.slice(0, e.start) + e.replacement + next.slice(e.end);
    }
    patchedFiles.set(file.path, next);
    perFile.push({ path: file.path, checked: matches.length, remapped: remappedCount, removed: removedCount });
  }

  return { valid, remappable, removed, patchedFiles, perFile };
}

function isCodeFile(path: string): boolean {
  return /\.(?:m?[jt]sx?|cjs|mjs)$/i.test(path);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convenience: applies the validation result onto the input file array, returning
 * a new array with patched contents. Used by the pipeline orchestrator after
 * Stage 11 to produce the file set Stage 12 sees.
 */
export function applyValidation<T extends ValidatorFile>(files: T[], result: ImportValidationResult): T[] {
  if (result.patchedFiles.size === 0) return files;
  return files.map(f => {
    const patched = result.patchedFiles.get(f.path);
    return patched !== undefined ? { ...f, content: patched } : f;
  });
}

/** True if the registry already contains the specifier's package root. */
export function isKnownPackage(spec: string): boolean {
  return ALL_KNOWN_PACKAGES.has(packageRoot(spec));
}

/** Re-exported for external callers that want to know which sets feed the validator. */
export const KNOWN_PACKAGE_SOURCES = {
  available: AVAILABLE_DEPS,
  dev: DEV_DEPS,
  total: ALL_KNOWN_PACKAGES,
};
