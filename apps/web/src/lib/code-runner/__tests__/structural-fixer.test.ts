// Task #24 — Guardrails for structural-fixer.ts.
//
// Covers the four required scenarios:
//   1. Planned name within budget → file is invented (backfill).
//   2. Unplanned name (or no plan supplied) → demoted to TODO + diagnostic.
//   3. Planned name but file budget exhausted → demoted to TODO + diagnostic
//      (`reason: 'budget-exhausted'`).
//   4. Diagnostic shape is dispatchable to the auto-fix loop with
//      `errorType: 'unresolved-import'` after `[unresolved-import]` strip.

import { describe, it, expect } from 'vitest';
import {
  analyzeAndAutoFix,
  isNameInPlan,
  checkInventionBudget,
  type PlanLookup,
  type InventionBudget,
} from '../structural-fixer';

interface F { id: number; path: string; content: string }

const importerOf = (name: string, path = '@/components/Widget'): F => ({
  id: 1,
  path: 'src/App.tsx',
  content: `import { ${name} } from "${path}";\n\nexport default function App() {\n  return <${name} />;\n}\n`,
});

describe('isNameInPlan', () => {
  const plan: PlanLookup = {
    componentNames: ['Widget'],
    hookNames: ['useThing'],
    pageNames: ['HomePage'],
    apiClientNames: ['api'],
    storeNames: ['userStore'],
  };
  it('classifies each plan category', () => {
    expect(isNameInPlan(plan, 'Widget').kind).toBe('component');
    expect(isNameInPlan(plan, 'useThing').kind).toBe('hook');
    expect(isNameInPlan(plan, 'HomePage').kind).toBe('page');
    expect(isNameInPlan(plan, 'api').kind).toBe('api');
    expect(isNameInPlan(plan, 'userStore').kind).toBe('store');
  });
  it('returns null for missing names and missing plan', () => {
    expect(isNameInPlan(plan, 'Random').kind).toBeNull();
    expect(isNameInPlan(undefined, 'Widget').kind).toBeNull();
    expect(isNameInPlan(plan, '').kind).toBeNull();
  });
});

describe('checkInventionBudget', () => {
  it('allows when no budget is supplied', () => {
    expect(
      checkInventionBudget(undefined, { filesCreated: 0, componentsCreated: 0, routesCreated: 0 }, 'component'),
    ).toBeNull();
  });
  it('denies when total file cap reached', () => {
    const budget: InventionBudget = { maxFiles: 8, currentFileCount: 8 };
    expect(
      checkInventionBudget(budget, { filesCreated: 0, componentsCreated: 0, routesCreated: 0 }, 'component'),
    ).toBe('budget-exhausted');
  });
  it('denies when component cap reached even if files left', () => {
    const budget: InventionBudget = { maxFiles: 50, maxComponents: 3, currentComponentCount: 3 };
    expect(
      checkInventionBudget(budget, { filesCreated: 0, componentsCreated: 0, routesCreated: 0 }, 'component'),
    ).toBe('budget-exhausted');
  });
});

describe('analyzeAndAutoFix — planned-backfill', () => {
  it('invents a stub for a planned component within budget', () => {
    const plan: PlanLookup = { componentNames: ['Widget'] };
    const budget: InventionBudget = { maxFiles: 20, currentFileCount: 1 };
    const result = analyzeAndAutoFix([importerOf('Widget')], { plan, budget });
    expect(result.backfilled.length).toBe(1);
    expect(result.backfilled[0]).toMatch(/Widget/);
    expect(result.unresolvedImports).toEqual([]);
    const created = result.fixes.find(f => f.type === 'broken-import');
    expect(created).toBeDefined();
    expect(created!.newContent).toMatch(/export function Widget/);
  });
});

describe('analyzeAndAutoFix — unplanned-demote', () => {
  it('demotes an unplanned import to a TODO and emits a diagnostic', () => {
    const plan: PlanLookup = { componentNames: ['DifferentThing'] };
    const budget: InventionBudget = { maxFiles: 20, currentFileCount: 1 };
    const result = analyzeAndAutoFix([importerOf('Widget')], { plan, budget });
    expect(result.backfilled).toEqual([]);
    expect(result.rejected).toEqual(['Widget']);
    expect(result.unresolvedImports).toHaveLength(1);
    expect(result.unresolvedImports[0]).toMatchObject({
      file: 'src/App.tsx',
      name: 'Widget',
      importPath: '@/components/Widget',
      reason: 'unplanned',
    });
    const demoted = result.fixes.find(f => f.type === 'demoted-import');
    expect(demoted).toBeDefined();
    expect(demoted!.newContent).toContain("TODO: unresolved import 'Widget'");
    // No new file should have been invented.
    expect(result.fixes.some(f => f.type === 'broken-import')).toBe(false);
  });

  it('treats a missing plan as no-plan rejection (not unplanned)', () => {
    const result = analyzeAndAutoFix([importerOf('Widget')]);
    expect(result.unresolvedImports[0].reason).toBe('no-plan');
    expect(result.backfilled).toEqual([]);
  });
});

describe('analyzeAndAutoFix — budget-exceeded-demote', () => {
  it('rejects a planned name when the file cap is reached', () => {
    const plan: PlanLookup = { componentNames: ['Widget'] };
    const budget: InventionBudget = { maxFiles: 1, currentFileCount: 1 };
    const result = analyzeAndAutoFix([importerOf('Widget')], { plan, budget });
    expect(result.backfilled).toEqual([]);
    expect(result.unresolvedImports).toHaveLength(1);
    expect(result.unresolvedImports[0].reason).toBe('budget-exhausted');
    expect(result.fixes.some(f => f.type === 'broken-import')).toBe(false);
  });

  it('rejects subsequent invention once cumulative count crosses the cap', () => {
    const plan: PlanLookup = { componentNames: ['Alpha', 'Beta', 'Gamma'] };
    const budget: InventionBudget = { maxFiles: 4, currentFileCount: 2 };
    const file: F = {
      id: 1,
      path: 'src/App.tsx',
      content: [
        `import { Alpha } from "@/components/Alpha";`,
        `import { Beta } from "@/components/Beta";`,
        `import { Gamma } from "@/components/Gamma";`,
        `export default function App() { return <><Alpha /><Beta /><Gamma /></>; }`,
      ].join('\n'),
    };
    const result = analyzeAndAutoFix([file], { plan, budget });
    // currentFileCount=2 + maxFiles=4 → 2 invention slots. Two backfills, one rejection.
    expect(result.backfilled).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.unresolvedImports[0].reason).toBe('budget-exhausted');
  });
});

describe('analyzeAndAutoFix — auto-fix dispatch shape', () => {
  it('produces diagnostics that survive the [unresolved-import] tag-strip the route uses', () => {
    const result = analyzeAndAutoFix([importerOf('Widget')]);
    expect(result.unresolvedImports.length).toBeGreaterThan(0);
    // Caller (preview-panel) formats:
    //   `[unresolved-import] ${file}:${line} — '${name}' from '${importPath}' (${reason})`
    const formatted = result.unresolvedImports.map(u =>
      `[unresolved-import] ${u.file}:${u.line} — '${u.name}' from '${u.importPath}' (${u.reason})`,
    );
    for (const line of formatted) {
      expect(line.startsWith('[unresolved-import] ')).toBe(true);
      // Mirrors the route's normalizer.
      const stripped = line.replace(/^\s*\[unresolved-import\]\s*/, '');
      expect(stripped).toMatch(/^src\/App\.tsx:\d+ — 'Widget'/);
    }
  });

  it('emits a single consolidated summary line', () => {
    const plan: PlanLookup = { componentNames: ['Widget'] };
    const budget: InventionBudget = { maxFiles: 20, currentFileCount: 1 };
    const file: F = {
      id: 1,
      path: 'src/App.tsx',
      content: [
        `import { Widget } from "@/components/Widget";`,
        `import { Random } from "@/components/Random";`,
        `export default function App() { return <><Widget /><Random /></>; }`,
      ].join('\n'),
    };
    const result = analyzeAndAutoFix([file], { plan, budget });
    expect(result.summary).toMatch(/Backfilled 1/);
    expect(result.summary).toMatch(/rejected 1/);
  });
});
