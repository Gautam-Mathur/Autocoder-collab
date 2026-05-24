/**
 * QUEEN — Intent interpreter (Fusion mode).
 * Adapts AutoCoder's existing UnderstandingResult (already produced upstream
 * by the deep-understanding-engine) into RuFlo's TaskSpec. Falls back to
 * keyword extraction only when no understanding has been provided.
 *
 * Reads:  legacyCtx.understanding, raw prompt
 * Writes: TaskSpec (mem.queen.taskSpec)
 */

import type { TaskSpec } from '../types.js';

interface LegacyCtx {
  understanding?: {
    level1_intent?: { primaryGoal?: string; userType?: string; coreFlow?: string };
    level2_domain?: { primaryDomain?: { id?: string; name?: string } };
    level3_entities?: { mentionedEntities?: Array<{ name: string }> };
    explicitNonGoals?: string[];
  };
  plan?: { projectName?: string; projectDescription?: string };
  requestedFeatures?: string[];
}

export async function runQueen(prompt: string, legacyCtx?: LegacyCtx): Promise<TaskSpec> {
  const u = legacyCtx?.understanding;
  if (u) {
    const domain =
      u.level2_domain?.primaryDomain?.id?.toLowerCase() ||
      u.level2_domain?.primaryDomain?.name?.toLowerCase().replace(/\s+/g, '-') ||
      'general';
    const features = (legacyCtx?.requestedFeatures && legacyCtx.requestedFeatures.length > 0)
      ? legacyCtx.requestedFeatures
      : extractFeatures(prompt);
    return {
      domain,
      userType: u.level1_intent?.userType || 'end user',
      coreFlow: u.level1_intent?.coreFlow || u.level1_intent?.primaryGoal || 'user interacts with the app',
      mustHaveFeatures: features.length > 0 ? features : ['main view', 'list items', 'create item'],
      explicitNonGoals: u.explicitNonGoals ?? [],
    };
  }

  // Standalone fallback (RuFlo without upstream understanding).
  const text = (prompt || legacyCtx?.plan?.projectDescription || legacyCtx?.plan?.projectName || '').toLowerCase();
  return {
    domain: detectDomain(text),
    userType: detectUserType(text),
    coreFlow: extractCoreFlow(text),
    mustHaveFeatures: extractFeatures(text),
    explicitNonGoals: extractNonGoals(text),
  };
}

const DOMAIN_KEYWORDS: Array<{ domain: string; keys: string[] }> = [
  { domain: 'hospitality',  keys: ['restaurant', 'reservation', 'booking', 'hotel', 'menu'] },
  { domain: 'ecommerce',    keys: ['shop', 'store', 'cart', 'checkout', 'product', 'ecommerce'] },
  { domain: 'productivity', keys: ['todo', 'task', 'kanban', 'project management', 'note'] },
  { domain: 'social',       keys: ['chat', 'message', 'post', 'feed', 'social', 'follow'] },
  { domain: 'finance',      keys: ['invoice', 'payment', 'wallet', 'budget', 'expense'] },
  { domain: 'education',    keys: ['course', 'lesson', 'quiz', 'school', 'student', 'learn'] },
  { domain: 'health',       keys: ['fitness', 'workout', 'health', 'meal', 'doctor'] },
  { domain: 'media',        keys: ['video', 'photo', 'gallery', 'music', 'podcast'] },
];

function detectDomain(text: string): string {
  for (const { domain, keys } of DOMAIN_KEYWORDS) if (keys.some((k) => text.includes(k))) return domain;
  return 'general';
}
function detectUserType(text: string): string {
  if (text.includes('admin')) return 'admin + end user';
  if (text.includes('team')) return 'team member';
  if (text.includes('customer') || text.includes('user')) return 'customer';
  return 'end user';
}
function extractCoreFlow(text: string): string {
  const verbs = ['create', 'manage', 'view', 'browse', 'book', 'order', 'track', 'send', 'plan'];
  const found = verbs.filter((v) => text.includes(v));
  return found.length === 0 ? 'user interacts with the app' : `user can ${found.slice(0, 3).join(' and ')}`;
}
function extractFeatures(text: string): string[] {
  const candidates: Array<[string, string]> = [
    ['booking', 'booking flow'], ['reservation', 'reservation system'], ['cart', 'shopping cart'],
    ['checkout', 'checkout'], ['login', 'authentication'], ['signup', 'authentication'],
    ['auth', 'authentication'], ['dashboard', 'dashboard'], ['admin', 'admin panel'],
    ['search', 'search'], ['filter', 'filtering'], ['profile', 'user profile'],
    ['settings', 'settings page'], ['notification', 'notifications'], ['chat', 'chat'],
    ['comment', 'comments'], ['review', 'reviews'], ['payment', 'payments'], ['calendar', 'calendar'],
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [k, label] of candidates) {
    if (text.toLowerCase().includes(k) && !seen.has(label)) { out.push(label); seen.add(label); }
  }
  return out.slice(0, 8);
}
function extractNonGoals(text: string): string[] {
  const out: string[] = [];
  if (text.includes('no payment') || text.includes('without payment')) out.push('payment processing');
  if (text.includes('no auth') || text.includes('no login')) out.push('authentication');
  if (text.includes('no admin')) out.push('admin panel');
  return out;
}
