/**
 * Smoke test for the complexity classifier + feature extractor + learning store.
 *
 * Run via: pnpm --filter @workspace/scripts exec tsx src/test-complexity-classifier.ts
 *
 * Verifies the three Layer-C contracts hold end-to-end:
 *   1. Context-aware sizing returns the expected tier for known requests.
 *   2. Strict-feature mode is engaged for small requests.
 *   3. The learning store persists outcomes and biases future classifications.
 */

import { classifyComplexity, complexitySignature } from '../../artifacts/api-server/src/src/modules/complexity-classifier.js';
import { extractRequestedFeatures } from '../../artifacts/api-server/src/src/modules/feature-extractor.js';
import {
  recordComplexityOutcome,
  findSimilarComplexity,
  clearStoreForTesting,
} from '../../artifacts/api-server/src/src/modules/complexity-learning-store.js';
import { filterConceptsToRequested } from '../../artifacts/api-server/src/src/templates/concept-library.js';

let passed = 0;
let failed = 0;
function assert(label: string, cond: boolean, extra?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); }
}

console.log('\n[1] Tier sizing by context');
{
  const counter = classifyComplexity('simple counter app');
  assert('simple counter → minimal/small', counter.tier === 'minimal' || counter.tier === 'small', `got ${counter.tier} (score=${counter.score})`);
  assert('simple counter → strict feature mode', counter.strictFeatureMode);

  const calc = classifyComplexity('basic calculator');
  assert('basic calculator → minimal/small', calc.tier === 'minimal' || calc.tier === 'small', `got ${calc.tier}`);

  const sciCalc = classifyComplexity('scientific calculator with history and dark mode');
  assert('scientific calc + history + dark → small/medium', sciCalc.tier === 'small' || sciCalc.tier === 'medium', `got ${sciCalc.tier}`);

  const saas = classifyComplexity(
    'production SaaS dashboard with auth, RBAC, billing via Stripe, admin panel, analytics, real-time notifications, multi-tenant'
  );
  assert('SaaS w/ auth+billing+admin → large/xl', saas.tier === 'large' || saas.tier === 'xl', `got ${saas.tier} (score=${saas.score})`);
  assert('SaaS → not strict mode', !saas.strictFeatureMode);
  assert('SaaS → run deep quality + arch', saas.shouldRunDeepQuality && saas.shouldRunArchitecture);

  const minimal = classifyComplexity('just a hello world page, no backend');
  assert('hello world no backend → minimal', minimal.tier === 'minimal', `got ${minimal.tier} (score=${minimal.score})`);
  assert('minimal → conceptBudget 0', minimal.conceptBudget === 0);
}

console.log('\n[2] Feature extraction (sticks to features)');
{
  const a = extractRequestedFeatures('todo app with dark mode and search');
  assert('todo + dark + search picks up dark-mode', a.requestedFeatures.includes('dark-mode'));
  assert('  ... and search', a.requestedFeatures.includes('search'));
  assert('  ... but NOT auth', !a.requestedFeatures.includes('auth'));

  const b = extractRequestedFeatures('plain calculator');
  assert('plain calculator: no features', b.requestedFeatures.length === 0, `got [${b.requestedFeatures.join(',')}]`);

  const c = extractRequestedFeatures('scientific calculator with history');
  assert('scientific → scientific feature', c.requestedFeatures.includes('scientific'));
  assert('scientific → maps to scientific-calculator concept', c.requestedConcepts.includes('scientific-calculator'));
  assert('history → maps to calculation-history concept', c.requestedConcepts.includes('calculation-history'));
}

console.log('\n[3] Concept filtering (strict-feature mode)');
{
  const candidates = ['scientific-calculator', 'calculation-history', 'dark-mode', 'auth-form', 'admin-dashboard'];
  const requested = ['calculation-history']; // user only asked for history
  const alwaysAllow = ['scientific-calculator']; // implied by detected variety

  const kept = filterConceptsToRequested(candidates, requested, alwaysAllow);
  assert('keeps explicitly requested', kept.includes('calculation-history'));
  assert('keeps always-allow (variety-implied)', kept.includes('scientific-calculator'));
  assert('drops unsolicited dark-mode', !kept.includes('dark-mode'));
  assert('drops unsolicited auth-form', !kept.includes('auth-form'));
  assert('drops unsolicited admin-dashboard', !kept.includes('admin-dashboard'));
}

console.log('\n[4] Learning store: persistence + bias');
{
  clearStoreForTesting();

  // No history yet → no similarity result.
  const empty = findSimilarComplexity(complexitySignature('todo app with dark mode'));
  assert('empty store → null lookup', empty === null);

  // Record 5 outcomes for "todo with dark mode" all landing on `medium`.
  const sig = complexitySignature('todo app with dark mode');
  for (let i = 0; i < 5; i++) {
    recordComplexityOutcome({
      signature: sig + ' run' + i,
      finalTier: 'medium',
      fileCount: 12,
      lineCount: 600,
      success: true,
    });
  }

  const found = findSimilarComplexity(complexitySignature('todo app dark mode'));
  assert('finds similar past runs', found !== null);
  assert('  → tier medium', found?.tier === 'medium', `got ${found?.tier}`);
  assert('  → confidence > 0.6', (found?.confidence ?? 0) > 0.6, `got ${found?.confidence}`);

  // The classifier should now bias towards medium for similar requests.
  const baseline = classifyComplexity('todo app with dark mode');
  // Even though raw signals would put this at small, learned bias should push it.
  assert('classifier acknowledges learned bias', baseline.learnedFromHistory || baseline.tier === 'medium',
    `tier=${baseline.tier} learned=${baseline.learnedFromHistory}`);

  clearStoreForTesting();
}

console.log('\n[5] Stable signature normalization');
{
  const a = complexitySignature('  TODO   APP with Dark Mode ');
  const b = complexitySignature('todo app with dark mode');
  assert('signatures normalize whitespace + case', a === b, `a="${a}" b="${b}"`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
