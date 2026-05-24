/**
 * Smoke test for the Layer A/B compositional code generator wiring.
 *
 *   pnpm --filter @workspace/scripts exec tsx src/test-app-archetypes.ts
 *
 * Verifies:
 *   1. Each archetype has a registered scaffold that returns a non-empty
 *      file list whose package.json + index.html (or server.js) is present.
 *   2. The scientific-calculator concept overlay overrides src/App.jsx on the
 *      calculator scaffold and adds the `evalExpr` helper.
 *   3. detectConcepts() picks up "scientific calculator with history" as both
 *      `scientific-calculator` and `calculation-history`.
 *   4. detectArchetypeVarieties() classifies the calculator's "scientific"
 *      and "tip" varieties from natural-language descriptions.
 *   5. The fullstack-todo path swaps scaffolds when "with backend" is asked.
 */

import {
  appArchetypes,
  detectArchetypeVarieties,
  impliedConceptsFromVarieties,
} from '../../artifacts/api-server/src/src/templates/app-archetypes.js';
import {
  detectConcepts,
  applyConceptOverlays,
} from '../../artifacts/api-server/src/src/templates/concept-library.js';
import {
  getScaffold,
  scaffoldRegistry,
} from '../../artifacts/api-server/src/src/templates/scaffolds/runnable-scaffolds.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n[1] Every scaffold returns a non-empty, valid file set');
for (const id of Object.keys(scaffoldRegistry)) {
  const files = getScaffold(id);
  if (!files || files.length === 0) {
    check(id, false, 'empty');
    continue;
  }
  const hasPkg = files.some((f) => f.path === 'package.json');
  const hasEntry = files.some((f) => f.path === 'index.html' || f.path === 'server.js');
  check(`${id}: ${files.length} files, pkg=${hasPkg}, entry=${hasEntry}`, hasPkg && hasEntry);
}

console.log('\n[2] Scientific concept overlays calculator scaffold');
{
  const base = getScaffold('calculator')!;
  const baseApp = base.find((f) => f.path === 'src/App.jsx')!.content;
  const { files: overlaid, appliedOverlays } = applyConceptOverlays(base, ['scientific-calculator']);
  const newApp = overlaid.find((f) => f.path === 'src/App.jsx')!.content;
  check('overlay applied', appliedOverlays.includes('scientific-calculator'));
  check('App.jsx replaced', newApp !== baseApp);
  check('contains evalExpr', newApp.includes('evalExpr'));
  check('file count preserved', overlaid.length === base.length);
}

console.log('\n[3] detectConcepts');
{
  const c1 = detectConcepts('scientific calculator with history', 'calculator');
  check('scientific + history detected', c1.includes('scientific-calculator') && c1.includes('calculation-history'), JSON.stringify(c1));
  const c2 = detectConcepts('todo app with dark mode and search', 'todo');
  check('dark mode + search', c2.includes('dark-mode') && c2.includes('search-filter'), JSON.stringify(c2));
  const c3 = detectConcepts('plain calculator', 'calculator');
  check('no spurious concepts on plain calculator', !c3.includes('scientific-calculator'), JSON.stringify(c3));
}

console.log('\n[4] detectArchetypeVarieties');
{
  const calc = appArchetypes.find((a) => a.id === 'calculator')!;
  check('scientific variety from "scientific calculator"',
    detectArchetypeVarieties(calc, 'build a scientific calculator').includes('scientific'));
  check('tip variety from "tip calculator"',
    detectArchetypeVarieties(calc, 'a tip calculator for restaurants').includes('tip'));
  check('no varieties from "simple calculator"',
    detectArchetypeVarieties(calc, 'a simple calculator').length === 0);

  const implied = impliedConceptsFromVarieties(calc, ['scientific']);
  check('scientific variety implies scientific-calculator concept',
    implied.includes('scientific-calculator'));
}

console.log('\n[5] Fullstack todo variety');
{
  const todo = appArchetypes.find((a) => a.id === 'todo')!;
  const v = detectArchetypeVarieties(todo, 'todo app with backend rest api');
  check('fullstack variety detected', v.includes('fullstack'));
  const fullstack = getScaffold('fullstack-todo');
  check('fullstack-todo scaffold exists', !!fullstack && fullstack.some((f) => f.path === 'server.js'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
