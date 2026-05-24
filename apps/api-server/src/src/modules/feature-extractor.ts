/**
 * Feature Extractor — pulls an explicit feature allowlist from a user's
 * request so downstream stages can "stick to features" and avoid silently
 * inventing capabilities the user did not ask for.
 *
 * Two distinct outputs:
 *   - `requestedFeatures`: a normalized list of short feature labels
 *     (e.g. `dark-mode`, `search`, `auth`, `export-csv`).
 *   - `requestedConcepts`: the subset of those features that map to ids in
 *     the concept-library; used by `filterConceptsToRequested(...)` (in
 *     concept-library) to prune default conceptTags in strict-feature mode.
 *
 * The matching is keyword-based and intentionally conservative: when in
 * doubt we DO NOT include a feature, because the cost of leaving out a
 * "maybe" is much lower than the cost of inventing one.
 */

import { conceptLibrary } from '../templates/concept-library.js';

export interface ExtractedFeatures {
  requestedFeatures: string[];
  requestedConcepts: string[];
}

const FEATURE_KEYWORDS: ReadonlyArray<{ id: string; triggers: RegExp[] }> = [
  { id: 'dark-mode',     triggers: [/\bdark[- ]mode\b/i, /\bdark theme\b/i, /\btheme toggle\b/i] },
  { id: 'search',        triggers: [/\bsearch(able)?\b/i, /\bfilter(ing)?\b/i, /\blook ?up\b/i] },
  { id: 'auth',          triggers: [/\bauth(entication)?\b/i, /\blog ?in\b/i, /\bsign[- ]?(in|up)\b/i, /\busers?\b/i] },
  { id: 'export',        triggers: [/\bexport\b/i, /\bdownload (csv|json|pdf)\b/i] },
  { id: 'import',        triggers: [/\bimport\b/i, /\bupload\b/i] },
  { id: 'pagination',    triggers: [/\bpaginat\w*\b/i, /\bprev next\b/i] },
  { id: 'sort',          triggers: [/\bsortable\b/i, /\bsort by\b/i, /\border by\b/i] },
  { id: 'charts',        triggers: [/\bchart\w*\b/i, /\bgraph\w*\b/i, /\bvisuali[sz]e\b/i] },
  { id: 'history',       triggers: [/\bhistory\b/i, /\bpast (calculations|entries)\b/i] },
  { id: 'persistence',   triggers: [/\bpersist\w*\b/i, /\blocal[- ]?storage\b/i, /\bsurvive (a )?reload\b/i, /\bsave my\b/i] },
  { id: 'notifications', triggers: [/\bnotification\w*\b/i, /\btoast\b/i, /\bsnackbar\b/i] },
  { id: 'admin',         triggers: [/\badmin\b/i, /\badmin (panel|dashboard)\b/i] },
  { id: 'backend',       triggers: [/\bbackend\b/i, /\bserver\b/i, /\brest api\b/i, /\bexpress\b/i, /\bfull[- ]?stack\b/i] },
  { id: 'realtime',      triggers: [/\breal[- ]?time\b/i, /\bwebsocket\b/i, /\blive (feed|updates?)\b/i] },
  { id: 'settings',      triggers: [/\bsettings?\b/i, /\bpreferences?\b/i] },
  { id: 'file-upload',   triggers: [/\bfile upload\b/i, /\bdrag and drop\b/i, /\bimage upload\b/i] },
  { id: 'scientific',    triggers: [/\bscientific\b/i, /\b(sin|cos|tan|log|sqrt)\b/i, /\btrigonometric\b/i] },
  { id: 'tip',           triggers: [/\btip\b/i, /\bgratuity\b/i, /\bsplit (the )?bill\b/i] },
];

/**
 * Map a feature id to one or more concept ids in `concept-library`. Concepts
 * not listed here remain available to detectConcepts() — this map is only
 * used to project the user's requested features INTO concept space.
 */
const FEATURE_TO_CONCEPT: Record<string, string[]> = {
  'dark-mode':     ['dark-mode'],
  'search':        ['search-filter'],
  'auth':          ['auth-form'],
  'export':        ['export-data'],
  'pagination':    ['pagination'],
  'sort':          ['sortable-table'],
  'charts':        ['charts'],
  'history':       ['calculation-history'],
  'persistence':   ['local-persistence'],
  'notifications': ['notifications'],
  'admin':         ['admin-dashboard'],
  'backend':       ['api-backend'],
  'settings':      ['settings-page'],
  'file-upload':   ['file-upload'],
  'scientific':    ['scientific-calculator', 'calculation-history'],
  'tip':           ['tip-calculator'],
};

export function extractRequestedFeatures(description: string): ExtractedFeatures {
  const features = new Set<string>();
  for (const { id, triggers } of FEATURE_KEYWORDS) {
    if (triggers.some((re) => re.test(description))) features.add(id);
  }

  const concepts = new Set<string>();
  for (const f of features) {
    for (const c of FEATURE_TO_CONCEPT[f] || []) concepts.add(c);
  }
  // Also add any concepts whose own triggers fired — keeps this in sync
  // when new concepts get added without mirror entries above.
  const lower = ' ' + description.toLowerCase() + ' ';
  for (const c of conceptLibrary) {
    for (const t of c.triggers) {
      const tl = ' ' + t.toLowerCase() + ' ';
      if (lower.includes(tl)) { concepts.add(c.id); break; }
    }
  }

  return {
    requestedFeatures: Array.from(features),
    requestedConcepts: Array.from(concepts),
  };
}
