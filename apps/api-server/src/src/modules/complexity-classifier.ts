/**
 * Complexity Classifier — context-aware sizing of generated code.
 *
 * The pipeline used to do "one-size-fits-all" generation: a request like
 * "simple counter" produced the same 50+ files as "full SaaS dashboard with
 * billing, auth, RBAC, and analytics". This module classifies a request's
 * intended size from natural-language signals (and a learned-pattern store
 * that gets better over time) so downstream stages can:
 *
 *   - skip non-essential pipeline stages on small requests,
 *   - drop default concept tags so the generator sticks to what the user
 *     actually asked for ("strict feature mode"),
 *   - and budget the SLM's micro-writer enhancement effort accordingly.
 *
 * Design notes:
 *   - The classifier is deterministic for a given signature, then biased by
 *     similar past outcomes (via `complexity-learning-store`). This means
 *     "build a calculator" → tier `small` consistently, but if 4 of the last
 *     5 calculator builds ended up needing tier `medium` we drift the
 *     decision upward.
 *   - All behaviour is opt-in: callers that don't pass a profile keep the
 *     existing pipeline behaviour exactly.
 */

import { findSimilarComplexity } from './complexity-learning-store.js';

export type ComplexityTier = 'minimal' | 'small' | 'medium' | 'large' | 'xl';

export interface ComplexityProfile {
  tier: ComplexityTier;
  score: number;             // 0–100
  signals: string[];         // human-readable reasons
  rationale: string;         // one-line summary used in thinking-step UI
  conceptBudget: number;     // soft cap on concept overlays (besides what user explicitly asked for)
  strictFeatureMode: boolean;// when true, drop default conceptTags / hint-only concepts
  shouldRunDeepQuality: boolean;
  shouldRunSchemaDesign: boolean;
  shouldRunArchitecture: boolean;
  shouldRunSLMEnhancement: boolean;
  /** Hard cap on generated file count for this tier. Pipeline emits a warning
   *  when generation exceeds this and downstream stages can use it as a hint. */
  maxFiles: number;
  /** Whether a backend (schema + API + server routes) should be generated. */
  shouldGenerateBackend: boolean;
  learnedFromHistory: boolean;
}

const SHRINK_PATTERNS: ReadonlyArray<{ re: RegExp; weight: number; reason: string }> = [
  { re: /\b(just|only|simple|simplest|basic|minimal|tiny|small|quick|toy|hello|demo|prototype|mvp|barebones|bare-bones|stripped[- ]down)\b/i, weight: -10, reason: 'minimalist wording' },
  { re: /\bone[- ]page\b/i, weight: -8, reason: 'one-page request' },
  { re: /\bno (auth|login|backend|database|db)\b/i, weight: -10, reason: 'explicitly excludes infra' },
  { re: /\b(static|frontend[- ]only|client[- ]side[- ]only)\b/i, weight: -8, reason: 'static / frontend-only' },
];

const GROW_PATTERNS: ReadonlyArray<{ re: RegExp; weight: number; reason: string }> = [
  { re: /\b(production|enterprise|saas|multi[- ]tenant|scalable)\b/i, weight: 18, reason: 'production / enterprise scope' },
  { re: /\b(auth|authentication|login|signup|sso|oauth|rbac|roles?|permissions?)\b/i, weight: 8, reason: 'auth & permissions' },
  { re: /\b(admin|administrator|admin panel|admin dashboard)\b/i, weight: 8, reason: 'admin surface' },
  { re: /\b(billing|subscription|payment|stripe|checkout|pricing)\b/i, weight: 12, reason: 'billing / payments' },
  { re: /\b(analytics|metrics|reporting|dashboard|kpi|charts?)\b/i, weight: 6, reason: 'analytics surface' },
  { re: /\b(notifications?|email|sms|webhook|push)\b/i, weight: 5, reason: 'notifications / messaging' },
  { re: /\b(websocket|realtime|real[- ]time|live updates|streaming)\b/i, weight: 8, reason: 'realtime' },
  { re: /\b(search|filter|sort|pagination|export|import|csv|pdf)\b/i, weight: 4, reason: 'data ops' },
  { re: /\b(test(s|ing)?|ci\/cd|deploy(ment)?|docker|kubernetes|k8s)\b/i, weight: 5, reason: 'devops / testing' },
  { re: /\b(ai|llm|gpt|chatbot|recommendation engine|machine learning|ml)\b/i, weight: 8, reason: 'AI / ML' },
  { re: /\b(audit log|history|versioning|workflow|state machine)\b/i, weight: 6, reason: 'audit / workflow' },
  { re: /\b(map|geolocation|gps|leaflet|mapbox)\b/i, weight: 6, reason: 'geospatial' },
];

const TIER_THRESHOLDS: Array<{ tier: ComplexityTier; max: number }> = [
  { tier: 'minimal', max: 8 },
  { tier: 'small',   max: 22 },
  { tier: 'medium',  max: 50 },
  { tier: 'large',   max: 80 },
  { tier: 'xl',      max: Infinity },
];

function tierFromScore(score: number): ComplexityTier {
  for (const t of TIER_THRESHOLDS) if (score <= t.max) return t.tier;
  return 'xl';
}

function tierIndex(t: ComplexityTier): number {
  return ['minimal', 'small', 'medium', 'large', 'xl'].indexOf(t);
}

/**
 * Compute a stable "signature" of the request — used as the lookup key in
 * the learning store. Lower-cased, trimmed, with whitespace collapsed.
 */
export function complexitySignature(description: string, archetypeId?: string | null): string {
  const norm = description.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
  return archetypeId ? `${archetypeId}::${norm}` : norm;
}

export interface ClassifyOptions {
  /** Best-known archetype id (used as a learning-store key prefix). */
  archetypeId?: string | null;
  /** Number of entities the parser found in the request. */
  entityCount?: number;
  /** Number of features explicitly enumerated by the user. */
  featureCount?: number;
  /** Pre-existing complexity score from `local-ai-engine.estimateComplexity` (0–100). */
  priorScore?: number;
}

export function classifyComplexity(description: string, opts: ClassifyOptions = {}): ComplexityProfile {
  const signals: string[] = [];
  let score = 0;

  const wc = description.trim().split(/\s+/).filter(Boolean).length;
  if (wc <= 6)   { score += 0;  signals.push(`brief request (${wc} words)`); }
  else if (wc <= 18) { score += 5;  signals.push(`short request (${wc} words)`); }
  else if (wc <= 50) { score += 12; signals.push(`medium request (${wc} words)`); }
  else if (wc <= 120){ score += 22; signals.push(`detailed request (${wc} words)`); }
  else               { score += 35; signals.push(`extensive spec (${wc} words)`); }

  for (const p of SHRINK_PATTERNS) {
    if (p.re.test(description)) { score += p.weight; signals.push(p.reason); }
  }
  for (const p of GROW_PATTERNS) {
    if (p.re.test(description)) { score += p.weight; signals.push(p.reason); }
  }

  const entityCount = opts.entityCount ?? 0;
  if (entityCount >= 6)      { score += 18; signals.push(`${entityCount} entities`); }
  else if (entityCount >= 3) { score += 10; signals.push(`${entityCount} entities`); }
  else if (entityCount >= 1) { score += 3;  signals.push(`${entityCount} entit${entityCount === 1 ? 'y' : 'ies'}`); }

  const featureCount = opts.featureCount ?? 0;
  if (featureCount >= 8)      { score += 12; signals.push(`${featureCount} features asked for`); }
  else if (featureCount >= 4) { score += 6;  signals.push(`${featureCount} features asked for`); }

  // Soft-blend with the existing local-ai-engine estimate if provided.
  if (typeof opts.priorScore === 'number' && opts.priorScore > 0) {
    score = Math.round(score * 0.7 + opts.priorScore * 0.3);
    signals.push(`prior estimate ${opts.priorScore}`);
  }

  // Clamp before learning bias so we have a stable base tier.
  score = Math.max(0, Math.min(100, score));
  let tier = tierFromScore(score);
  let learnedFromHistory = false;

  // Learning bias: if past similar requests landed on a different tier with
  // high confidence, drift our decision toward that tier (one step max so we
  // never blindly trust a single bad sample).
  try {
    const sig = complexitySignature(description, opts.archetypeId ?? null);
    const learned = findSimilarComplexity(sig);
    if (learned && learned.confidence >= 0.6 && learned.tier !== tier) {
      const delta = tierIndex(learned.tier) - tierIndex(tier);
      if (delta !== 0) {
        const stepped: ComplexityTier = (['minimal','small','medium','large','xl'] as const)[tierIndex(tier) + Math.sign(delta)];
        signals.push(`learned bias → ${learned.tier} (n=${learned.sampleCount}, conf=${learned.confidence.toFixed(2)})`);
        tier = stepped;
        learnedFromHistory = true;
      }
    }
  } catch { /* learning store is best-effort */ }

  const isStrict = tier === 'minimal' || tier === 'small';
  const profile: ComplexityProfile = {
    tier,
    score,
    signals,
    rationale: `${tier.toUpperCase()} (score=${score}; ${signals.slice(0, 3).join('; ')})`,
    conceptBudget: ({ minimal: 0, small: 2, medium: 4, large: 8, xl: 16 } as const)[tier],
    strictFeatureMode: isStrict,
    shouldRunDeepQuality:    !isStrict,
    shouldRunSchemaDesign:   tier !== 'minimal',
    shouldRunArchitecture:   tierIndex(tier) >= tierIndex('medium'),
    shouldRunSLMEnhancement: tier !== 'minimal',
    maxFiles: ({ minimal: 8, small: 15, medium: 35, large: 80, xl: Number.POSITIVE_INFINITY } as const)[tier],
    shouldGenerateBackend:   tier !== 'minimal',
    learnedFromHistory,
  };

  return profile;
}
