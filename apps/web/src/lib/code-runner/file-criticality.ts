// file-criticality.ts — pure classifier deciding whether a generated
// project file is "critical" for boot.
//
// Used by the verify-then-start gate so a broken NON-critical file
// (test, story, leaf component) gets stubbed and the dev server still
// boots in degraded mode, while a broken CRITICAL file (entry HTML,
// vite config, root App, server entry) keeps the existing hard-abort.
//
// Pure function — no I/O, no async — so it stays trivial to unit-test.

export interface CriticalityResult {
  critical: boolean;
  reason: string;
}

// Order matters: non-critical patterns are checked first so a test file
// living under a critical directory (e.g. `server/__tests__/x.test.ts`)
// is correctly classified as non-critical.
const NON_CRITICAL_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /(?:^|\/)__tests__\//, reason: 'test directory (__tests__)' },
  { re: /\.test\.[mc]?[jt]sx?$/i, reason: 'test file (*.test.*)' },
  { re: /\.spec\.[mc]?[jt]sx?$/i, reason: 'spec file (*.spec.*)' },
  { re: /\.stories\.[mc]?[jt]sx?$/i, reason: 'storybook file (*.stories.*)' },
  // Plural-only forms — these MUST stay aligned with the
  // NON_RUNTIME_PATTERNS globs emitted by the
  // react-vite-express adapter so the gate's view of
  // "non-runtime" matches Vite's view exactly. Do not
  // broaden to singular without updating the adapter too.
  { re: /(?:^|\/)examples\//, reason: 'examples directory' },
  { re: /(?:^|\/)docs\//, reason: 'docs directory' },
  { re: /(?:^|\/)__mocks__\//, reason: 'mocks directory' },
  { re: /\.fixture\.[mc]?[jt]sx?$/i, reason: 'fixture file' },
];

const CRITICAL_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /^index\.html$/i, reason: 'entry HTML (index.html)' },
  { re: /(?:^|\/)src\/main\.[mc]?[jt]sx?$/i, reason: 'app entry (src/main.*)' },
  { re: /(?:^|\/)src\/index\.[mc]?[jt]sx?$/i, reason: 'app entry (src/index.*)' },
  { re: /(?:^|\/)src\/App\.[mc]?[jt]sx?$/i, reason: 'root component (src/App.*)' },
  { re: /(?:^|\/)vite\.config\.[mc]?[jt]sx?$/i, reason: 'vite config' },
  { re: /^package\.json$/i, reason: 'package.json' },
  { re: /^tsconfig(?:\.[a-z0-9]+)?\.json$/i, reason: 'tsconfig' },
  { re: /(?:^|\/)server\//i, reason: 'server module' },
  { re: /(?:^|\/)src\/router(?:\.[a-z]+|s\/)/i, reason: 'router module' },
  { re: /(?:^|\/)src\/routes\//i, reason: 'routes module' },
];

/**
 * Classify a file path as critical (must parse for the app to boot)
 * or non-critical (can be safely stubbed if it won't parse).
 *
 * SAFETY-FIRST DEFAULT: an unknown file is treated as CRITICAL. Without
 * an import-graph proof that a leaf module is genuinely isolated from
 * the entrypoints, stubbing it could let the app "boot" and then crash
 * on the first import. We only fast-path to non-critical when the file
 * matches a known pattern that is provably non-runtime (tests, stories,
 * fixtures, mocks, examples, docs).
 *
 * The escape hatch for genuinely-isolated leaves is the explicit
 * NON_CRITICAL_PATTERNS list — extend that, never the default.
 */
export function classifyFileCriticality(path: string): CriticalityResult {
  // Normalize leading "./" so the patterns work with either form.
  const p = path.replace(/^\.\//, '');
  for (const { re, reason } of NON_CRITICAL_PATTERNS) {
    if (re.test(p)) return { critical: false, reason };
  }
  for (const { re, reason } of CRITICAL_PATTERNS) {
    if (re.test(p)) return { critical: true, reason };
  }
  return {
    critical: true,
    reason: 'unknown runtime file (conservative critical; could be reachable from app entrypoint)',
  };
}

/**
 * Convenience: returns true iff the file should be EXCLUDED from the
 * dev-server transform graph and the verify gate's parse-check.
 * (Tests, stories, fixtures, mocks, examples, docs.)
 */
export function isNonRuntimeFile(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  for (const { re } of NON_CRITICAL_PATTERNS) {
    if (re.test(p)) return true;
  }
  return false;
}
