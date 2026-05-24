/**
 * App Archetypes — Layer A of the compositional code generator.
 *
 * Each archetype represents a recognizable kind of app the generator knows
 * how to bootstrap end-to-end (calculator, todo, weather, dashboard, …).
 * They are matched by `template-registry.findArchetypes()` against the user's
 * description.
 *
 * Beyond the legacy metadata fields (id/name/category/description/keywords/
 * features/entities/pages), each archetype now optionally declares:
 *
 *   - `scaffoldId`   — id in `scaffolds/runnable-scaffolds.ts` whose file-set
 *                      should seed the codegen pipeline (Layer A).
 *   - `conceptTags`  — concept ids ALWAYS applied to this archetype
 *                      (e.g. calculator → 'calculation-history' is implicit
 *                      when a model larger than nano is used; we keep these
 *                      conservative and let `detectConcepts()` add more from
 *                      the user's wording).
 *   - `varieties`    — sub-types ('scientific', 'tip') with the concept ids
 *                      they imply when their variety triggers fire.
 *   - `complexity`   — 'simple' | 'medium' | 'complex'. Drives downstream
 *                      decisions (e.g. extension-mode prompt budget).
 *   - `requiresBackend` — true for full-stack archetypes (informs which scaffold
 *                      to seed and whether to emit Express server modules).
 *
 * If you add a new archetype:
 *  1. (optionally) add a scaffold in `scaffolds/runnable-scaffolds.ts`,
 *  2. wire its id here,
 *  3. add discriminating keywords to `keywords[]` so the registry can find it.
 */

export interface ArchetypeVariety {
  id: string;
  name: string;
  /** Lower-case substrings/words; if any are found in the user description, this variety activates. */
  triggers: string[];
  /** Concept ids implied by this variety (in addition to the base archetype's `conceptTags`). */
  implies: string[];
}

export interface AppArchetype {
  id: string;
  name: string;
  category: string;
  description: string;
  keywords: string[];
  features: string[];
  entities: Array<{ name: string; description?: string }>;
  pages: string[];

  // Layer A: concrete starting scaffold
  scaffoldId?: string;

  // Layer B: composability hints
  conceptTags?: string[];
  varieties?: ArchetypeVariety[];

  // Misc metadata
  complexity?: 'simple' | 'medium' | 'complex';
  requiresBackend?: boolean;
}

export const appArchetypes: AppArchetype[] = [
  // -------------------------------------------------------------------
  {
    id: 'counter',
    name: 'Counter / Clicker',
    category: 'utility',
    description: 'A simple stateful counter with increment/decrement/reset.',
    keywords: ['counter', 'clicker', 'increment', 'decrement', 'tally', 'click counter', 'simple counter'],
    features: ['increment', 'decrement', 'reset', 'state'],
    entities: [{ name: 'Counter', description: 'The current numeric value being tracked' }],
    pages: ['Home'],
    scaffoldId: 'counter',
    complexity: 'simple',
    requiresBackend: false,
  },

  // -------------------------------------------------------------------
  {
    id: 'calculator',
    name: 'Calculator',
    category: 'utility',
    description: 'A four-function (or scientific / tip) calculator.',
    keywords: ['calculator', 'calc', 'arithmetic', 'compute', 'math app', 'computation'],
    features: ['arithmetic', 'expression input', 'clear', 'history (when requested)'],
    entities: [{ name: 'Expression' }, { name: 'Result' }],
    pages: ['Calculator'],
    scaffoldId: 'calculator',
    conceptTags: [],
    varieties: [
      { id: 'scientific', name: 'Scientific', triggers: ['scientific', 'sin', 'cos', 'tan', 'log', 'sqrt', 'trigonometric', 'advanced'], implies: ['scientific-calculator', 'calculation-history'] },
      { id: 'tip',        name: 'Tip / Bill split', triggers: ['tip', 'gratuity', 'split bill', 'restaurant'], implies: ['tip-calculator'] },
      { id: 'with-history', name: 'With history', triggers: ['history', 'past calculations', 'remember calculations'], implies: ['calculation-history'] },
    ],
    complexity: 'simple',
    requiresBackend: false,
  },

  // -------------------------------------------------------------------
  {
    id: 'todo',
    name: 'Todo / Task list',
    category: 'productivity',
    description: 'A todo list with add/complete/delete; full-stack variety adds an Express REST API.',
    keywords: ['todo', 'task list', 'tasks', 'checklist', 'to-do', 'task manager', 'task tracker'],
    features: ['add task', 'complete task', 'delete task', 'list view'],
    entities: [
      { name: 'Task', description: 'A single todo item with text + completion state' },
    ],
    pages: ['Tasks'],
    scaffoldId: 'todo',
    conceptTags: [],
    varieties: [
      { id: 'fullstack', name: 'Full-stack (Express)', triggers: ['fullstack', 'full stack', 'full-stack', 'backend', 'api', 'express', 'server', 'rest'], implies: ['api-backend'] },
    ],
    complexity: 'simple',
    requiresBackend: false,
  },

  // -------------------------------------------------------------------
  {
    id: 'fullstack-todo',
    name: 'Full-stack Todo',
    category: 'productivity',
    description: 'Todo list with Express backend exposing a JSON REST API.',
    keywords: ['fullstack todo', 'todo api', 'todo backend', 'express todo', 'rest todo', 'todo with backend'],
    features: ['add task', 'toggle task', 'delete task', 'rest api', 'persistent storage'],
    entities: [{ name: 'Task' }],
    pages: ['Tasks'],
    scaffoldId: 'fullstack-todo',
    conceptTags: [],
    complexity: 'medium',
    requiresBackend: true,
  },

  // -------------------------------------------------------------------
  {
    id: 'weather',
    name: 'Weather lookup',
    category: 'utility',
    description: 'A weather-by-city lookup using mock data (no API key required).',
    keywords: ['weather', 'forecast', 'temperature', 'climate', 'meteorology', 'weather app'],
    features: ['city search', 'temperature display', 'humidity', 'wind speed'],
    entities: [{ name: 'City' }, { name: 'WeatherReport' }],
    pages: ['Weather'],
    scaffoldId: 'weather',
    complexity: 'simple',
    requiresBackend: false,
  },

  // -------------------------------------------------------------------
  {
    id: 'notes',
    name: 'Notes / Note-taking',
    category: 'productivity',
    description: 'A localStorage-backed note-taking app with a sidebar and editor.',
    keywords: ['notes', 'notebook', 'memo', 'note taking', 'note-taking', 'markdown notes', 'jot', 'journal'],
    features: ['create note', 'edit note', 'persistent storage', 'sidebar list'],
    entities: [{ name: 'Note', description: 'Title + body, persisted locally' }],
    pages: ['Notes'],
    scaffoldId: 'notes',
    conceptTags: ['local-persistence'],
    varieties: [
      { id: 'with-search', name: 'With search', triggers: ['search', 'filter', 'searchable'], implies: ['search-filter'] },
    ],
    complexity: 'simple',
    requiresBackend: false,
  },

  // -------------------------------------------------------------------
  {
    id: 'dashboard',
    name: 'Analytics Dashboard',
    category: 'analytics',
    description: 'A metrics dashboard with KPI cards, a bar chart, and a recent-activity table.',
    keywords: ['dashboard', 'analytics', 'metrics', 'kpi', 'admin', 'stats', 'reports', 'overview'],
    features: ['kpi cards', 'bar chart', 'data table', 'metrics overview'],
    entities: [{ name: 'Metric' }, { name: 'Customer' }],
    pages: ['Overview'],
    scaffoldId: 'dashboard',
    conceptTags: ['charts'],
    varieties: [
      { id: 'with-export', name: 'With export', triggers: ['export', 'download csv', 'download'], implies: ['export-data'] },
    ],
    complexity: 'medium',
    requiresBackend: false,
  },
];

/**
 * Resolve which varieties of a given archetype are triggered by the description.
 * Returns the variety ids in declaration order.
 */
export function detectArchetypeVarieties(archetype: AppArchetype, description: string): string[] {
  if (!archetype.varieties || archetype.varieties.length === 0) return [];
  const lower = ' ' + description.toLowerCase() + ' ';
  const matched: string[] = [];
  for (const variety of archetype.varieties) {
    for (const t of variety.triggers) {
      const tl = t.toLowerCase();
      if (lower.includes(' ' + tl + ' ') || lower.includes(' ' + tl) || lower.includes(tl + ' ')) {
        matched.push(variety.id);
        break;
      }
    }
  }
  return matched;
}

/**
 * Resolve concept ids implied by a list of variety ids on a given archetype.
 */
export function impliedConceptsFromVarieties(archetype: AppArchetype, varietyIds: string[]): string[] {
  const out = new Set<string>();
  for (const v of archetype.varieties || []) {
    if (!varietyIds.includes(v.id)) continue;
    for (const c of v.implies) out.add(c);
  }
  return Array.from(out);
}
