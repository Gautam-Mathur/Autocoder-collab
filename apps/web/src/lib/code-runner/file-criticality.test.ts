import { describe, it, expect } from 'vitest';
import { classifyFileCriticality, isNonRuntimeFile } from './file-criticality';

describe('classifyFileCriticality — critical patterns', () => {
  const CRITICAL_CASES: { path: string; reason: RegExp }[] = [
    { path: 'index.html', reason: /entry HTML/i },
    { path: 'src/main.tsx', reason: /app entry/i },
    { path: 'src/main.ts', reason: /app entry/i },
    { path: 'src/main.jsx', reason: /app entry/i },
    { path: 'src/main.js', reason: /app entry/i },
    { path: 'src/index.tsx', reason: /app entry/i },
    { path: 'src/App.tsx', reason: /root component/i },
    { path: 'src/App.jsx', reason: /root component/i },
    { path: 'vite.config.ts', reason: /vite config/i },
    { path: 'vite.config.mjs', reason: /vite config/i },
    { path: 'package.json', reason: /package\.json/i },
    { path: 'tsconfig.json', reason: /tsconfig/i },
    { path: 'tsconfig.node.json', reason: /tsconfig/i },
    { path: 'server/index.ts', reason: /server module/i },
    { path: 'server/routes/foo.ts', reason: /server module/i },
    { path: 'src/router.ts', reason: /router module/i },
    { path: 'src/routers/main.ts', reason: /router module/i },
    { path: 'src/routes/index.tsx', reason: /routes module/i },
  ];

  for (const { path, reason } of CRITICAL_CASES) {
    it(`classifies ${path} as critical`, () => {
      const r = classifyFileCriticality(path);
      expect(r.critical).toBe(true);
      expect(r.reason).toMatch(reason);
    });
  }
});

describe('classifyFileCriticality — non-critical patterns', () => {
  const NON_CRITICAL_CASES: { path: string; reason: RegExp }[] = [
    { path: '__tests__/setup.ts', reason: /test directory/i },
    { path: 'src/__tests__/utils.test.ts', reason: /test directory/i },
    { path: 'src/Foo.test.tsx', reason: /test file/i },
    { path: 'src/Foo.spec.ts', reason: /spec file/i },
    { path: 'src/Foo.stories.tsx', reason: /storybook file/i },
    // Plural-only patterns — kept aligned with the adapter's
    // NON_RUNTIME_PATTERNS globs (`examples/**`, `docs/**`).
    // Singular `example/` and `doc/` fall through to the default
    // (leaf module) classification on purpose.
    { path: 'examples/basic-usage.tsx', reason: /examples/i },
    { path: 'docs/intro.md', reason: /docs/i },
    { path: '__mocks__/react.ts', reason: /mocks/i },
    { path: 'src/components/data.fixture.ts', reason: /fixture/i },
  ];

  for (const { path, reason } of NON_CRITICAL_CASES) {
    it(`classifies ${path} as non-critical`, () => {
      const r = classifyFileCriticality(path);
      expect(r.critical).toBe(false);
      expect(r.reason).toMatch(reason);
    });
  }
});

describe('classifyFileCriticality — unknown leaf files default to CRITICAL', () => {
  // Safety-first: an unknown leaf module could be reachable from the
  // app entrypoint. Stubbing it would let the app "boot" only to crash
  // on the first import. The classifier must conservatively keep these
  // critical so the gate aborts honestly instead of falsely degrading.
  const UNKNOWN_LEAF_CASES = [
    'src/components/Button.tsx',
    'src/hooks/useThing.ts',
    'src/lib/util.ts',
    'src/services/api-client.ts',
    'src/store/user.ts',
  ];

  for (const path of UNKNOWN_LEAF_CASES) {
    it(`classifies ${path} as critical (conservative default)`, () => {
      const r = classifyFileCriticality(path);
      expect(r.critical).toBe(true);
      expect(r.reason).toMatch(/unknown runtime file/i);
    });
  }
});

describe('classifyFileCriticality — non-critical wins over critical when both match', () => {
  it('server/__tests__/x.test.ts is non-critical (test under server)', () => {
    const r = classifyFileCriticality('server/__tests__/x.test.ts');
    expect(r.critical).toBe(false);
    expect(r.reason).toMatch(/test/i);
  });

  it('src/routes/foo.test.ts is non-critical (test under routes)', () => {
    const r = classifyFileCriticality('src/routes/foo.test.ts');
    expect(r.critical).toBe(false);
  });

  it('src/main.test.ts is non-critical (a test, not the entry)', () => {
    const r = classifyFileCriticality('src/main.test.ts');
    expect(r.critical).toBe(false);
  });
});

describe('classifyFileCriticality — leading ./ normalization', () => {
  it('handles "./src/main.tsx" the same as "src/main.tsx"', () => {
    expect(classifyFileCriticality('./src/main.tsx').critical).toBe(true);
  });
  it('handles "./__tests__/x.ts" the same as "__tests__/x.ts"', () => {
    expect(classifyFileCriticality('./__tests__/x.ts').critical).toBe(false);
  });
});

describe('isNonRuntimeFile', () => {
  it('returns true for tests/stories/fixtures/mocks/examples/docs', () => {
    expect(isNonRuntimeFile('__tests__/x.ts')).toBe(true);
    expect(isNonRuntimeFile('src/Foo.test.tsx')).toBe(true);
    expect(isNonRuntimeFile('src/Foo.spec.ts')).toBe(true);
    expect(isNonRuntimeFile('src/Foo.stories.tsx')).toBe(true);
    expect(isNonRuntimeFile('examples/x.ts')).toBe(true);
    expect(isNonRuntimeFile('docs/x.ts')).toBe(true);
    expect(isNonRuntimeFile('__mocks__/x.ts')).toBe(true);
    expect(isNonRuntimeFile('data.fixture.ts')).toBe(true);
  });

  it('returns false for runtime files', () => {
    expect(isNonRuntimeFile('src/main.tsx')).toBe(false);
    expect(isNonRuntimeFile('src/App.tsx')).toBe(false);
    expect(isNonRuntimeFile('src/components/Button.tsx')).toBe(false);
    expect(isNonRuntimeFile('vite.config.ts')).toBe(false);
    expect(isNonRuntimeFile('server/index.ts')).toBe(false);
  });
});
