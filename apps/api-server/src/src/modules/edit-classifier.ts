/**
 * Initiative B — Surgical Edit Classifier
 *
 * Classifies an iterative-edit user message into one of:
 *   - `style-only`     CSS/Tailwind/className/colour/spacing/typography only
 *   - `copy-only`      Strings/labels/text in JSX literals
 *   - `schema-add`     Pure additive entity/field/column changes
 *   - `route-change`   Add/rename a route or page
 *   - `fullrun`        Anything else (safe default — runs the full pipeline)
 *
 * The classifier is conservative by design. When in doubt, return `fullrun`.
 * That keeps us behaviourally identical to today (no surgical executor wired
 * yet) while exposing the classification for future consumers (e.g. a
 * surgical-edit executor, telemetry, dry-run preview).
 *
 * NO behaviour change is wired up by default — this module is exported and
 * available, but `conversation-phase-handler.ts` keeps calling
 * `handleIterativeEdit` until a future task opts surgical mode in.
 */

export type EditClass =
  | 'style-only'
  | 'copy-only'
  | 'schema-add'
  | 'route-change'
  | 'fullrun';

export interface EditClassification {
  kind: EditClass;
  confidence: number;     // 0..1
  signals: string[];      // matched phrases (audit trail)
  /** Files we expect to touch when this is a non-fullrun edit (best-effort). */
  expectedFiles?: string[];
  /** Plain-English explanation suitable for a thinking step. */
  rationale: string;
}

const STYLE_PATTERNS: RegExp[] = [
  /\b(color|colour|background|bg|text-color|font-size|font-weight|spacing|padding|margin|rounded|border|shadow|gradient|theme|dark mode|light mode|tailwind|css|className)\b/i,
  /\bmake (it|the .+) (bigger|smaller|wider|taller|narrower|prettier|cleaner|rounder|darker|lighter|bolder)\b/i,
  /\b(restyle|recolor|recolour|reskin|polish|tidy up the (look|design|ui|styling))\b/i,
];

const COPY_PATTERNS: RegExp[] = [
  /\b(rename|change the (text|label|title|heading|button text|copy|wording)|change "[^"]+" to "[^"]+")\b/i,
  /\b(call it|name it|label it) ['"][^'"]+['"]/i,
  /\b(typo|fix the wording|fix the text|change the message)\b/i,
];

const SCHEMA_PATTERNS: RegExp[] = [
  /\badd (a|an) (new )?(field|column|attribute|property) (called |named )?[\w]+ (to|on|for) (the )?\w+/i,
  /\badd (a|an) (new )?\w+ (entity|model|table)\b/i,
  /\b(track|store|persist) (a |the )?\w+ (for|on|per) (the )?\w+/i,
];

const ROUTE_PATTERNS: RegExp[] = [
  /\badd (a|an) (new )?(page|route|screen|view) (called |for |to )?[\w/-]+/i,
  /\bcreate (a|an) (new )?(page|route|screen|view) (for |to |called )?[\w/-]+/i,
  /\b(rename|move) (the )?(page|route) [\w/-]+ to [\w/-]+/i,
];

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\b(remove|delete|drop|destroy|wipe|clear) (the |all )?(field|column|entity|table|page|route|component)\b/i,
  /\brefactor\b/i,
  /\brewrite\b/i,
  /\bredesign\b/i,
  /\bregenerate (everything|the whole|all)\b/i,
];

function matchAny(msg: string, patterns: RegExp[]): string[] {
  const hits: string[] = [];
  for (const p of patterns) {
    const m = msg.match(p);
    if (m) hits.push(m[0]);
  }
  return hits;
}

/**
 * Classify a free-form edit instruction. Pure function — no side effects,
 * no I/O, safe to call from any phase.
 */
export function classifyEdit(userMessage: string): EditClassification {
  const msg = (userMessage || '').trim();

  // Anything destructive forces fullrun — surgical edits MUST be additive.
  const destructive = matchAny(msg, DESTRUCTIVE_PATTERNS);
  if (destructive.length > 0) {
    return {
      kind: 'fullrun',
      confidence: 0.9,
      signals: destructive,
      rationale: 'Destructive change detected — running the full pipeline to keep the project consistent.',
    };
  }

  const style = matchAny(msg, STYLE_PATTERNS);
  const copy = matchAny(msg, COPY_PATTERNS);
  const schema = matchAny(msg, SCHEMA_PATTERNS);
  const route = matchAny(msg, ROUTE_PATTERNS);

  // Pick the highest-signal category. Ties default to fullrun.
  const counts: Array<[EditClass, number, string[]]> = [
    ['style-only', style.length, style],
    ['copy-only', copy.length, copy],
    ['schema-add', schema.length, schema],
    ['route-change', route.length, route],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const [topKind, topCount, topSignals] = counts[0];
  const [, secondCount] = counts[1];

  // Need a clear winner AND no competing strong signal from another kind.
  if (topCount > 0 && topCount > secondCount) {
    const confidence = Math.min(0.95, 0.55 + topCount * 0.15);
    return {
      kind: topKind,
      confidence,
      signals: topSignals,
      rationale: rationaleFor(topKind, topSignals),
    };
  }

  return {
    kind: 'fullrun',
    confidence: 0.6,
    signals: [],
    rationale: 'No clear surgical pattern detected — defaulting to full pipeline so nothing is missed.',
  };
}

function rationaleFor(kind: EditClass, signals: string[]): string {
  const head = signals[0] || '';
  switch (kind) {
    case 'style-only':
      return `Looks like a styling tweak ("${head}") — could be applied without rerunning planning.`;
    case 'copy-only':
      return `Looks like a copy/text change ("${head}") — affects strings only.`;
    case 'schema-add':
      return `Looks like an additive schema change ("${head}") — could be applied without re-architecting.`;
    case 'route-change':
      return `Looks like a route/page change ("${head}") — affects routing wiring.`;
    case 'fullrun':
      return 'Defaulting to full pipeline.';
  }
}

/**
 * Returns true when the classifier is confident enough that a future
 * surgical-edit executor could safely take this edit. Today this is
 * advisory only — no caller acts on it.
 */
export function isSurgicalCandidate(c: EditClassification): boolean {
  return c.kind !== 'fullrun' && c.confidence >= 0.7;
}
