/**
 * Concept Library — small, composable building blocks (Layer B).
 *
 * Concepts are reusable extensions that augment an archetype scaffold rather
 * than replacing it. They come in two flavors:
 *
 *   1. **Overlay concepts** — provide additional files (or replace specific
 *      existing files) when the user's description matches their tags.
 *      Example: "scientific calculator" → overlays `src/lib/parser.js` and a
 *      replacement `src/App.jsx` onto the basic calculator scaffold.
 *
 *   2. **Hint concepts** — only carry tags + dependency hints (no files).
 *      They surface in the strategic plan so the SLM can extend the scaffold
 *      in extension-mode codegen with awareness of the requested capability.
 *
 * Concepts are detected from the user's description by `detectConcepts()`
 * using simple keyword/phrase matching against `triggers`. Detected concepts
 * are attached to `ArchetypeMatch.appliedConcepts` and consumed by the
 * codegen-orchestrator (overlay) and slm-stage-codegen (extension hints).
 *
 * Adding a new concept: define it here, add to `conceptLibrary`, and reference
 * it from an archetype's `conceptTags` if it should be the default for that
 * archetype.
 */

import type { ScaffoldFile } from './scaffolds/runnable-scaffolds.js';

export interface AppConcept {
  id: string;
  name: string;
  description: string;
  /** Lower-case substrings/words that, if present in the user description, activate this concept. */
  triggers: string[];
  /** Other concepts that this concept implies (transitively activated). */
  implies?: string[];
  /** Archetype ids this concept is compatible with; empty/undefined means "any". */
  appliesTo?: string[];
  /**
   * Files to overlay onto the scaffold. Paths overwrite existing scaffold files.
   * Build dynamically so we can read existing scaffold content if needed in the future.
   */
  files?: () => ScaffoldFile[];
  /**
   * Extension hints surfaced to the SLM in extension-mode codegen.
   * Used to expand the import allowlist and prompt the model.
   */
  extensionHints?: {
    addedFunctions?: string[];
    addedFiles?: string[];
    allowedImports?: string[];
    promptSnippet?: string;
  };
}

// =====================================================================
// Calculator-family concepts
// =====================================================================

const scientificCalculator: AppConcept = {
  id: 'scientific-calculator',
  name: 'Scientific calculator buttons',
  description: 'Adds sin/cos/tan/log/sqrt/^/π/e and a small expression parser to a basic calculator.',
  triggers: ['scientific', 'trigonometric', 'sine', 'cosine', 'tangent', 'logarithm', 'square root', 'sqrt', 'advanced calc'],
  appliesTo: ['calculator'],
  files: () => [
    {
      path: 'src/App.jsx',
      language: 'jsx',
      content: `import { useState } from 'react';

function evalExpr(expr) {
  const safe = expr
    .replace(/π/g, '(' + Math.PI + ')')
    .replace(/(?<![a-zA-Z])e(?![a-zA-Z])/g, '(' + Math.E + ')')
    .replace(/\\^/g, '**')
    .replace(/sin\\(/g, 'Math.sin(')
    .replace(/cos\\(/g, 'Math.cos(')
    .replace(/tan\\(/g, 'Math.tan(')
    .replace(/log\\(/g, 'Math.log10(')
    .replace(/ln\\(/g, 'Math.log(')
    .replace(/sqrt\\(/g, 'Math.sqrt(');
  if (!/^[-+*/().0-9\\sMath.PIEsincoatlgqrt*]+$/.test(safe)) {
    throw new Error('Invalid expression');
  }
  // eslint-disable-next-line no-new-func
  return Function('"use strict"; return (' + safe + ')')();
}

export default function App() {
  const [expr, setExpr] = useState('');
  const [result, setResult] = useState('0');
  const [history, setHistory] = useState([]);

  const press = (s) => setExpr(expr + s);
  const clear = () => { setExpr(''); setResult('0'); };
  const back = () => setExpr(expr.slice(0, -1));

  const calculate = () => {
    try {
      const r = evalExpr(expr || '0');
      const out = Number.isFinite(r) ? String(+r.toFixed(10)) : 'Error';
      setResult(out);
      setHistory([{ expr, result: out, ts: Date.now() }, ...history].slice(0, 20));
    } catch {
      setResult('Error');
    }
  };

  const buttons = [
    'sin(', 'cos(', 'tan(', 'log(', 'ln(',
    'sqrt(', '^',  'π',   'e',   '(',
    '7',    '8',   '9',   '/',   ')',
    '4',    '5',   '6',   '*',   'C',
    '1',    '2',   '3',   '-',   'DEL',
    '0',    '.',   '+',   '=',   '+/-',
  ];

  const onClick = (b) => {
    if (b === '=') return calculate();
    if (b === 'C') return clear();
    if (b === 'DEL') return back();
    if (b === '+/-') return setExpr('-(' + (expr || '0') + ')');
    press(b);
  };

  return (
    <div className="calculator" style={{ minWidth: 360 }}>
      <div className="display">
        <div className="previous">{expr || ' '}</div>
        <div className="current">{result}</div>
      </div>
      <div className="buttons" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
        {buttons.map((b) => (
          <button
            key={b}
            className={b === '=' ? 'equals' : (b === 'C' ? 'clear' : (/[\\/*+\\-^]/.test(b) ? 'operator' : ''))}
            onClick={() => onClick(b)}
          >
            {b}
          </button>
        ))}
      </div>
      {history.length > 0 && (
        <div className="history-panel">
          <h3>History</h3>
          {history.map((h) => (
            <div key={h.ts} className="history-item" onClick={() => setExpr(h.expr)}>
              {h.expr} = {h.result}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
`,
    },
  ],
  extensionHints: {
    addedFunctions: ['evalExpr'],
    promptSnippet: 'Calculator must support sin/cos/tan/log/ln/sqrt/^/π/e using a sandboxed expression evaluator.',
  },
};

const calculationHistory: AppConcept = {
  id: 'calculation-history',
  name: 'Persistent calculation history',
  description: 'Adds a history list above/below the calculator that records past calculations.',
  triggers: ['history', 'history list', 'past calculations', 'with history', 'remember calculations'],
  appliesTo: ['calculator'],
  extensionHints: {
    addedFunctions: ['pushHistory'],
    allowedImports: [],
    promptSnippet: 'Maintain a calculation history (most recent first, max ~20 entries) and render it under the calculator.',
  },
};

const tipCalculator: AppConcept = {
  id: 'tip-calculator',
  name: 'Tip calculator variety',
  description: 'Replaces the basic calculator with a tip/split-bill calculator.',
  triggers: ['tip', 'tip calculator', 'gratuity', 'split bill', 'split the bill', 'restaurant'],
  appliesTo: ['calculator'],
  files: () => [
    {
      path: 'src/App.jsx',
      language: 'jsx',
      content: `import { useMemo, useState } from 'react';

export default function App() {
  const [bill, setBill] = useState('');
  const [tipPct, setTipPct] = useState(15);
  const [people, setPeople] = useState(1);

  const { tip, total, perPerson } = useMemo(() => {
    const b = parseFloat(bill) || 0;
    const t = b * (tipPct / 100);
    const tot = b + t;
    return { tip: t, total: tot, perPerson: tot / Math.max(1, people) };
  }, [bill, tipPct, people]);

  return (
    <div className="calculator" style={{ minWidth: 320 }}>
      <div className="display">
        <div className="previous">Tip calculator</div>
        <div className="current">$\{perPerson.toFixed(2)\}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <label>Bill amount
          <input style={{ width: '100%', padding: '0.5rem', marginTop: 4, background: '#0f0f23', color: '#e2e8f0', border: '1px solid #374151', borderRadius: 6 }}
                 type="number" value={bill} onChange={(e) => setBill(e.target.value)} placeholder="0.00" />
        </label>
        <label>Tip {tipPct}%
          <input style={{ width: '100%' }} type="range" min={0} max={30} value={tipPct} onChange={(e) => setTipPct(+e.target.value)} />
        </label>
        <label>Split between {people} people
          <input style={{ width: '100%' }} type="range" min={1} max={10} value={people} onChange={(e) => setPeople(+e.target.value)} />
        </label>
        <div style={{ marginTop: '0.5rem', color: '#94a3b8' }}>
          Tip: $\{tip.toFixed(2)\} · Total: $\{total.toFixed(2)\}
        </div>
      </div>
    </div>
  );
}
`,
    },
  ],
  extensionHints: { promptSnippet: 'Render a tip-and-split bill calculator with sliders for tip% and people count.' },
};

// =====================================================================
// Cross-cutting hint concepts (no files; just SLM extension hints)
// =====================================================================

const darkMode: AppConcept = {
  id: 'dark-mode',
  name: 'Dark mode toggle',
  description: 'Add a theme toggle that persists user preference.',
  triggers: ['dark mode', 'dark theme', 'light mode', 'theme toggle', 'theme switch'],
  extensionHints: {
    addedFunctions: ['useTheme'],
    promptSnippet: 'Add a dark/light theme toggle button that persists choice in localStorage.',
  },
};

const searchFilter: AppConcept = {
  id: 'search-filter',
  name: 'Search & filter',
  description: 'Inline search input that filters the visible list.',
  triggers: ['search', 'filter', 'searchable', 'find by name', 'lookup'],
  extensionHints: { promptSnippet: 'Add an inline text search input that filters the list by name.' },
};

const exportData: AppConcept = {
  id: 'export-data',
  name: 'Export data',
  description: 'Export current data as JSON or CSV via a download button.',
  triggers: ['export', 'download csv', 'download json', 'backup', 'export data'],
  extensionHints: { promptSnippet: 'Add an Export button that downloads the data as CSV or JSON.' },
};

const authForm: AppConcept = {
  id: 'auth-form',
  name: 'Login/signup form',
  description: 'Adds a simple email/password auth flow (mocked unless backend exists).',
  triggers: ['auth', 'login', 'signup', 'sign in', 'sign up', 'authentication', 'user account'],
  extensionHints: {
    addedFiles: ['src/Login.jsx'],
    addedFunctions: ['useAuth'],
    promptSnippet: 'Add an /login route with email+password form. Persist session in localStorage if no backend.',
  },
};

const charts: AppConcept = {
  id: 'charts',
  name: 'Charts & visualizations',
  description: 'Renders bar/line charts using inline SVG (no chart library needed).',
  triggers: ['chart', 'graph', 'visualization', 'visualize', 'bar chart', 'line chart', 'pie chart'],
  extensionHints: { promptSnippet: 'Add inline-SVG bar/line charts. Avoid heavy chart libraries unless explicitly requested.' },
};

const settingsPage: AppConcept = {
  id: 'settings-page',
  name: 'Settings page',
  description: 'Adds a /settings page for user preferences.',
  triggers: ['settings', 'preferences', 'config page', 'options page'],
  extensionHints: { addedFiles: ['src/Settings.jsx'] },
};

const persistence: AppConcept = {
  id: 'local-persistence',
  name: 'localStorage persistence',
  description: 'Persist app state to localStorage so it survives reloads.',
  triggers: ['save data', 'persist', 'local storage', 'remember', 'survive reload', 'persistent'],
  extensionHints: { promptSnippet: 'Persist primary state to localStorage and restore on mount.' },
};

const fileUpload: AppConcept = {
  id: 'file-upload',
  name: 'File upload',
  description: 'Adds a file picker with optional drag-and-drop.',
  triggers: ['upload', 'file upload', 'drag and drop', 'attach file', 'image upload'],
  extensionHints: { promptSnippet: 'Add a file picker (with drag-and-drop) that surfaces selected files in state.' },
};

const pagination: AppConcept = {
  id: 'pagination',
  name: 'Pagination',
  description: 'Add prev/next/page-number controls to long lists.',
  triggers: ['pagination', 'pages', 'paginate', 'prev next'],
  extensionHints: { promptSnippet: 'Paginate the list (10/page) with prev/next buttons.' },
};

const sortableTable: AppConcept = {
  id: 'sortable-table',
  name: 'Sortable table',
  description: 'Click column headers to sort ascending/descending.',
  triggers: ['sortable', 'sort by', 'order by', 'sortable table', 'sortable list'],
  extensionHints: { promptSnippet: 'Make table column headers click-to-sort (asc/desc toggle).' },
};

const notifications: AppConcept = {
  id: 'notifications',
  name: 'Toast notifications',
  description: 'Show transient toast messages for feedback.',
  triggers: ['notification', 'toast', 'snackbar', 'alert message', 'feedback message'],
  extensionHints: { promptSnippet: 'Add a small toast notification system for user feedback.' },
};

const adminDashboard: AppConcept = {
  id: 'admin-dashboard',
  name: 'Admin dashboard',
  description: 'Add an /admin route with metrics and management.',
  triggers: ['admin', 'admin panel', 'admin dashboard', 'management dashboard'],
  extensionHints: { addedFiles: ['src/Admin.jsx'] },
};

const apiBackend: AppConcept = {
  id: 'api-backend',
  name: 'REST API backend',
  description: 'Promote a frontend-only scaffold to a full-stack one with Express + REST.',
  triggers: ['backend', 'rest api', 'express', 'server', 'full stack', 'fullstack', 'api endpoint'],
  extensionHints: { promptSnippet: 'Promote the app to a full-stack architecture with an Express REST API and JSON persistence.' },
};

// =====================================================================
// Registry + detection
// =====================================================================

export const conceptLibrary: AppConcept[] = [
  // Calculator family
  scientificCalculator,
  calculationHistory,
  tipCalculator,
  // Cross-cutting
  darkMode,
  searchFilter,
  exportData,
  authForm,
  charts,
  settingsPage,
  persistence,
  fileUpload,
  pagination,
  sortableTable,
  notifications,
  adminDashboard,
  apiBackend,
];

export function getConcept(id: string): AppConcept | null {
  return conceptLibrary.find((c) => c.id === id) || null;
}

/**
 * Detects concepts triggered by the user's description.
 * Returns concept ids in stable order, deduplicated, with `implies` expanded.
 */
export function detectConcepts(description: string, archetypeId?: string): string[] {
  const lower = ' ' + description.toLowerCase() + ' ';
  const detected = new Set<string>();

  for (const concept of conceptLibrary) {
    if (concept.appliesTo && archetypeId && !concept.appliesTo.includes(archetypeId)) continue;
    for (const trigger of concept.triggers) {
      const t = trigger.toLowerCase();
      // word-boundary-ish match: trigger surrounded by non-alnum
      if (lower.includes(' ' + t + ' ') || lower.includes(' ' + t) || lower.includes(t + ' ')) {
        detected.add(concept.id);
        break;
      }
    }
  }

  // Expand implies
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const id of Array.from(detected)) {
      const c = getConcept(id);
      if (!c?.implies) continue;
      for (const dep of c.implies) {
        if (!detected.has(dep)) {
          detected.add(dep);
          expanded = true;
        }
      }
    }
  }

  return Array.from(detected);
}

/**
 * Apply concept overlays to a scaffold file list.
 * Files in concepts overwrite scaffold files at the same path. Other files are appended.
 */
export function applyConceptOverlays(
  scaffoldFiles: ScaffoldFile[],
  conceptIds: string[],
): { files: ScaffoldFile[]; appliedOverlays: string[] } {
  const map = new Map<string, ScaffoldFile>(scaffoldFiles.map((f) => [f.path, f]));
  const appliedOverlays: string[] = [];

  for (const id of conceptIds) {
    const concept = getConcept(id);
    if (!concept?.files) continue;
    appliedOverlays.push(id);
    for (const file of concept.files()) {
      map.set(file.path, file);
    }
  }

  return { files: Array.from(map.values()), appliedOverlays };
}

/**
 * Restrict a candidate concept set to only those the user actually asked for.
 *
 * Used in "strict feature mode" (small / minimal complexity tiers): the
 * candidate list typically contains both description-detected concepts AND
 * default `archetype.conceptTags` defaults; in strict mode we drop the
 * defaults so generation sticks to what the user requested. The intersection
 * with `requestedConceptIds` is the safe set.
 *
 * `alwaysAllow` is a list of concept ids that should pass through even in
 * strict mode (e.g. file-overlay concepts implied by a detected variety —
 * "scientific" → `scientific-calculator` should not be dropped).
 */
export function filterConceptsToRequested(
  candidateConceptIds: string[],
  requestedConceptIds: string[],
  alwaysAllow: string[] = [],
): string[] {
  const requested = new Set(requestedConceptIds);
  const allowed = new Set(alwaysAllow);
  return candidateConceptIds.filter((id) => requested.has(id) || allowed.has(id));
}

/**
 * Build a string of extension hints for a list of concept ids — used by
 * extension-mode SLM codegen to inform the model what additional capabilities
 * the user requested beyond the base scaffold.
 */
export function buildConceptExtensionPrompt(conceptIds: string[]): string {
  const parts: string[] = [];
  for (const id of conceptIds) {
    const c = getConcept(id);
    if (!c?.extensionHints?.promptSnippet) continue;
    parts.push(`- [${c.id}] ${c.extensionHints.promptSnippet}`);
  }
  if (parts.length === 0) return '';
  return `Additional requested capabilities (extend the scaffold to include these):\n${parts.join('\n')}`;
}

/**
 * Collect the union of allowed import paths declared by selected concepts.
 * Used by extension-mode codegen to relax the no-new-imports gate.
 */
export function collectAllowedImports(conceptIds: string[]): string[] {
  const set = new Set<string>();
  for (const id of conceptIds) {
    const c = getConcept(id);
    if (!c?.extensionHints?.allowedImports) continue;
    for (const imp of c.extensionHints.allowedImports) set.add(imp);
  }
  return Array.from(set);
}
