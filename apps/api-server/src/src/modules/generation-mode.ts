/**
 * Generation Mode — explicit, score-derived generation tier with hard budgets.
 *
 * Maps the existing complexity tiers (minimal/small/medium/large/xl) onto four
 * user-visible modes (Micro/Standard/Fullstack/Enterprise) and pins each mode
 * to a hard budget that downstream producers must obey:
 *
 *   - maxFiles, maxComponents, maxRoutes, maxRuntimeDeps
 *   - backend / database / auth feature flags
 *
 * The mode is derived deterministically from `ComplexityProfile.score` (with
 * an archetype override for trivial single-purpose apps like calculators
 * and todos so they never silently escalate to Fullstack).
 *
 * This replaces ad-hoc substring escalation ("complete app", "real app", …)
 * inside the various producers — the budget is now an explicit object on the
 * pipeline context, surfaced through OrchestrationResult → PhaseResult →
 * donePayload → chat UI.
 */

import type { ComplexityProfile, ComplexityTier } from './complexity-classifier.js';

export type GenerationMode = 'Micro' | 'Standard' | 'Fullstack' | 'Enterprise';

export interface GenerationBudget {
  mode: GenerationMode;
  maxFiles: number;
  maxComponents: number;
  maxRuntimeDeps: number;
  maxRoutes: number;
  backend: boolean;
  database: boolean;
  auth: boolean;
}

export const MODE_BUDGETS: Record<GenerationMode, GenerationBudget> = {
  Micro: {
    mode: 'Micro',
    maxFiles: 6,
    maxComponents: 3,
    maxRuntimeDeps: 3,
    maxRoutes: 0,
    backend: false,
    database: false,
    auth: false,
  },
  Standard: {
    mode: 'Standard',
    maxFiles: 15,
    maxComponents: 8,
    maxRuntimeDeps: 6,
    maxRoutes: 3,
    backend: false,
    database: false,
    auth: false,
  },
  Fullstack: {
    mode: 'Fullstack',
    maxFiles: 40,
    maxComponents: 20,
    maxRuntimeDeps: 15,
    maxRoutes: 12,
    backend: true,
    database: true,
    auth: false,
  },
  Enterprise: {
    mode: 'Enterprise',
    maxFiles: Number.POSITIVE_INFINITY,
    maxComponents: Number.POSITIVE_INFINITY,
    maxRuntimeDeps: Number.POSITIVE_INFINITY,
    maxRoutes: Number.POSITIVE_INFINITY,
    backend: true,
    database: true,
    auth: true,
  },
};

const TIER_TO_MODE: Record<ComplexityTier, GenerationMode> = {
  minimal: 'Micro',
  small: 'Standard',
  medium: 'Standard',
  large: 'Fullstack',
  xl: 'Enterprise',
};

const MICRO_ARCHETYPES = new Set([
  'calculator',
  'counter',
  'tip-calculator',
  'unit-converter',
  'stopwatch',
  'timer',
  'pomodoro',
  'dice',
  'coin-flip',
  'qr-generator',
]);

const STANDARD_ARCHETYPES = new Set([
  'todo',
  'todo-list',
  'notes',
  'weather',
  'pomodoro-tracker',
]);

export interface DeriveOptions {
  archetypeId?: string | null;
  /** When true, signals from the request explicitly ask for backend/db/auth. */
  hasBackendSignals?: boolean;
}

/**
 * Derive a GenerationMode from a complexity profile (score-based, not
 * substring-based). Archetype overrides force trivial single-purpose apps
 * down to Micro/Standard so a request like "calculator with auth" doesn't
 * silently escalate the whole pipeline to Fullstack.
 */
export function deriveGenerationMode(
  profile: ComplexityProfile | undefined | null,
  opts: DeriveOptions = {},
): GenerationMode {
  const archetypeId = opts.archetypeId?.toLowerCase().trim();
  if (archetypeId && MICRO_ARCHETYPES.has(archetypeId)) return 'Micro';
  if (archetypeId && STANDARD_ARCHETYPES.has(archetypeId) && !opts.hasBackendSignals) {
    return 'Standard';
  }

  if (!profile) return 'Standard';

  // Score-based escalation. Thresholds align with TIER_THRESHOLDS in
  // complexity-classifier.ts but collapse five tiers down to four modes.
  const score = profile.score;
  if (score <= 8) return 'Micro';
  if (score <= 35) return 'Standard';
  if (score <= 70) return 'Fullstack';
  return 'Enterprise';
}

export function getBudget(mode: GenerationMode): GenerationBudget {
  return MODE_BUDGETS[mode];
}

/**
 * Heuristic, score-style probe used by routes that don't run the full
 * pipeline (the AI fullstack endpoint, pro-generator routes, etc.) so they
 * can derive a mode without re-running the classifier.
 */
export function inferModeFromPrompt(prompt: string): GenerationMode {
  const lower = (prompt || '').toLowerCase();
  let score = 15; // neutral midpoint

  if (/\b(simple|simplest|basic|minimal|tiny|just|only|toy|hello|demo)\b/.test(lower)) score -= 12;
  if (/\bone[- ]page\b|\bsingle[- ]page\b/.test(lower)) score -= 6;
  if (/\b(static|frontend[- ]only|client[- ]side[- ]only|no (auth|backend|database|db))\b/.test(lower)) score -= 8;

  if (/\b(auth|login|signup|sso|oauth|rbac)\b/.test(lower)) score += 10;
  if (/\b(database|postgres|mysql|mongo|sqlite|prisma|drizzle)\b/.test(lower)) score += 10;
  if (/\b(api|backend|server|express|fastapi)\b/.test(lower)) score += 8;
  if (/\b(payment|billing|stripe|checkout|subscription)\b/.test(lower)) score += 14;
  if (/\b(production|enterprise|saas|multi[- ]tenant|scalable)\b/.test(lower)) score += 18;
  if (/\b(realtime|websocket|live updates|streaming)\b/.test(lower)) score += 8;
  if (/\b(ai|llm|gpt|chatbot|recommendation engine|machine learning)\b/.test(lower)) score += 8;

  // Archetype overrides (cheap text match — not the same as our archetype
  // detector but good enough for routes that only have a raw prompt).
  if (/\b(calculator|counter|tip|stopwatch|timer|pomodoro|dice|coin[- ]flip|qr)\b/.test(lower)) {
    return 'Micro';
  }

  if (score <= 8) return 'Micro';
  if (score <= 35) return 'Standard';
  if (score <= 70) return 'Fullstack';
  return 'Enterprise';
}

/**
 * Trim a generated file array to the budget, preserving canonical entry
 * files. Returns the trimmed array and the names of dropped files.
 */
export function enforceFileBudget<T extends { path: string }>(
  files: T[],
  budget: GenerationBudget,
): { kept: T[]; dropped: T[] } {
  if (!Number.isFinite(budget.maxFiles) || files.length <= budget.maxFiles) {
    return { kept: files, dropped: [] };
  }

  const max = budget.maxFiles;
  const priorityRanks: Array<(p: string) => boolean> = [
    p => p === 'package.json',
    p => p === 'index.html',
    p => p === 'vite.config.js' || p === 'vite.config.ts',
    p => p === 'tsconfig.json' || p === 'tsconfig.app.json' || p === 'tsconfig.node.json',
    p => p === 'tailwind.config.js' || p === 'tailwind.config.ts' || p === 'postcss.config.js' || p === 'postcss.config.cjs',
    p => /^src\/main\.(t|j)sx?$/.test(p),
    p => /^src\/App\.(t|j)sx?$/.test(p),
    p => /^src\/index\.css$/.test(p),
    p => /^src\/(pages|routes)\//.test(p),
    p => /^src\/components\//.test(p),
    p => /^src\/(lib|utils|hooks)\//.test(p),
    p => p.startsWith('src/'),
  ];

  const ranked = files.map((f, i) => {
    const rank = priorityRanks.findIndex(r => r(f.path));
    return { f, i, rank: rank < 0 ? priorityRanks.length : rank };
  });
  ranked.sort((a, b) => (a.rank - b.rank) || (a.i - b.i));

  const kept = ranked.slice(0, max).map(r => r.f);
  const keptSet = new Set(kept.map(f => f.path));
  const dropped = files.filter(f => !keptSet.has(f.path));
  return { kept, dropped };
}
