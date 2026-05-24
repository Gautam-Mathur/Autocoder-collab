import { getAllDomains } from './domain-knowledge.js';
import type { IndustryDomain, DomainModule } from './domain-knowledge.js';

export interface ScoredSuggestion {
  name: string;
  description: string;
  capabilityDescription: string;
  entities: string[];
  features: string[];
  pages: { name: string; features: string[] }[];
  score: number;
  domainId: string;
  domainName: string;
  source: 'kb_suggestion';
  confidence: number;
  userConfirmed: boolean;
}

export interface SuggestionTrackingRecord {
  domain: string;
  suggestion: string;
  shown: boolean;
  accepted: boolean;
  explicitlyRejected: boolean;
  timestamp: number;
}

export interface SuggestionResult {
  suggestions: ScoredSuggestion[];
  headerText: string;
  tracking: SuggestionTrackingRecord[];
}

interface DetectedDomainInput {
  domain: IndustryDomain;
  confidence: number;
}

const GATEWAY_MODULES = new Set([
  'dashboard', 'authentication', 'user management', 'admin panel',
  'settings', 'core crud', 'admin', 'home',
]);

const EXCLUSION_MAP: Record<string, string[]> = {
  'marketplace': ['single-vendor checkout', 'single vendor', 'simple checkout'],
  'single-vendor checkout': ['marketplace'],
  'multi-tenant': ['single-tenant', 'personal'],
  'single-tenant': ['multi-tenant'],
  'self-hosted': ['cloud-only', 'saas-only'],
  'cloud-only': ['self-hosted', 'on-premise'],
  'b2b': ['b2c consumer'],
  'b2c consumer': ['b2b'],
};

const UNIVERSAL_FALLBACK: ScoredSuggestion[] = [
  {
    name: 'Authentication',
    description: 'Login, signup, and user sessions',
    capabilityDescription: 'Let users create accounts, log in securely, and manage their sessions',
    entities: ['User', 'Session'],
    features: ['login', 'signup', 'password-reset', 'session-management'],
    pages: [{ name: 'Login Page', features: ['login', 'signup'] }, { name: 'Password Reset', features: ['password-reset'] }],
    score: 1.0,
    domainId: 'universal',
    domainName: 'Universal',
    source: 'kb_suggestion',
    confidence: 0.85,
    userConfirmed: false,
  },
  {
    name: 'Dashboard',
    description: 'Overview with key metrics',
    capabilityDescription: 'Let users see an at-a-glance overview of key metrics and recent activity',
    entities: [],
    features: ['kpi-cards', 'charts', 'recent-activity'],
    pages: [{ name: 'Dashboard Overview', features: ['kpi-cards', 'charts', 'recent-activity'] }],
    score: 0.95,
    domainId: 'universal',
    domainName: 'Universal',
    source: 'kb_suggestion',
    confidence: 0.85,
    userConfirmed: false,
  },
  {
    name: 'Core Data Management',
    description: 'Create, read, update, delete records',
    capabilityDescription: 'Let users create, view, edit, and delete the main data records in the system',
    entities: [],
    features: ['crud', 'search', 'filter', 'sort', 'pagination'],
    pages: [{ name: 'Data List', features: ['crud', 'search', 'filter', 'pagination'] }],
    score: 0.9,
    domainId: 'universal',
    domainName: 'Universal',
    source: 'kb_suggestion',
    confidence: 0.85,
    userConfirmed: false,
  },
  {
    name: 'Search & Filtering',
    description: 'Find and filter data quickly',
    capabilityDescription: 'Let users find records quickly with full-text search, filters, and sorting',
    entities: [],
    features: ['search', 'filter', 'autocomplete', 'sort'],
    pages: [{ name: 'Search Results', features: ['search', 'filter', 'autocomplete', 'sort'] }],
    score: 0.85,
    domainId: 'universal',
    domainName: 'Universal',
    source: 'kb_suggestion',
    confidence: 0.85,
    userConfirmed: false,
  },
  {
    name: 'Settings & Profile',
    description: 'User preferences and account settings',
    capabilityDescription: 'Let users manage their profile, preferences, and account settings',
    entities: ['UserProfile', 'Settings'],
    features: ['profile-edit', 'preferences', 'notification-settings'],
    pages: [{ name: 'Profile Settings', features: ['profile-edit', 'preferences'] }, { name: 'Notification Settings', features: ['notification-settings'] }],
    score: 0.8,
    domainId: 'universal',
    domainName: 'Universal',
    source: 'kb_suggestion',
    confidence: 0.85,
    userConfirmed: false,
  },
  {
    name: 'Notifications',
    description: 'In-app and email notifications',
    capabilityDescription: 'Let users receive timely alerts about important events and updates',
    entities: ['Notification', 'NotificationPreference'],
    features: ['in-app-alerts', 'email-notifications', 'notification-preferences'],
    pages: [{ name: 'Notification Center', features: ['in-app-alerts', 'notification-preferences'] }],
    score: 0.75,
    domainId: 'universal',
    domainName: 'Universal',
    source: 'kb_suggestion',
    confidence: 0.85,
    userConfirmed: false,
  },
];

function computeModuleFrequency(): Map<string, number> {
  const freq = new Map<string, number>();
  const allDomains = getAllDomains();
  for (const domain of allDomains) {
    for (const mod of domain.modules) {
      const key = mod.name.toLowerCase();
      freq.set(key, (freq.get(key) || 0) + 1);
    }
  }
  return freq;
}

let cachedFrequency: Map<string, number> | null = null;
function getModuleFrequency(): Map<string, number> {
  if (!cachedFrequency) {
    cachedFrequency = computeModuleFrequency();
  }
  return cachedFrequency;
}

function normalizeName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stemWord(word: string): string {
  let w = word.toLowerCase().trim();
  if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('tion') && w.length > 5) w = w.slice(0, -4);
  else if (w.endsWith('ment') && w.length > 5) w = w.slice(0, -4);
  else if (w.endsWith('ness') && w.length > 5) w = w.slice(0, -4);
  else if (w.endsWith('able') && w.length > 5) w = w.slice(0, -4);
  else if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (w.endsWith('es') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) w = w.slice(0, -1);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  return w;
}

function buildModuleAliases(mod: DomainModule): string[] {
  const aliases: string[] = [];

  aliases.push(normalizeName(mod.name));
  const nameWords = mod.name.toLowerCase().split(/[\s&/,]+/).filter(w => w.length > 2);
  for (const w of nameWords) {
    aliases.push(w);
    aliases.push(stemWord(w));
  }

  for (const page of mod.pages) {
    aliases.push(normalizeName(page.name));
    const pageWords = page.name.toLowerCase().split(/[\s&/,]+/).filter(w => w.length > 2);
    for (const w of pageWords) {
      aliases.push(w);
      aliases.push(stemWord(w));
    }
    for (const feat of page.features) {
      aliases.push(normalizeName(feat));
    }
  }

  for (const entity of mod.entities) {
    aliases.push(entity.toLowerCase());
    aliases.push(stemWord(entity));
  }

  return [...new Set(aliases)];
}

function toCapabilityDescription(mod: DomainModule): string {
  const desc = mod.description.trim();
  if (/^let\s/i.test(desc) || /^allow\s/i.test(desc) || /^enable\s/i.test(desc)) {
    return desc.charAt(0).toUpperCase() + desc.slice(1);
  }
  if (/^(view|see|access|manage|track|monitor|browse|get|use)\s/i.test(desc)) {
    return `Let users ${desc.charAt(0).toLowerCase() + desc.slice(1)}`;
  }
  const firstWord = desc.split(/\s+/)[0];
  const isAcronym = firstWord.length <= 4 && firstWord === firstWord.toUpperCase() && /^[A-Z]+$/.test(firstWord);
  if (isAcronym) {
    return `Let users access ${desc}`;
  }
  return `Let users access ${desc.charAt(0).toLowerCase() + desc.slice(1)}`;
}

function filterIncompatible(candidates: { mod: DomainModule; domainId: string; domainName: string; domainConfidence: number }[]): typeof candidates {
  const removed = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    if (removed.has(i)) continue;
    const nameI = candidates[i].mod.name.toLowerCase();
    for (const [key, exclusions] of Object.entries(EXCLUSION_MAP)) {
      if (nameI.includes(key)) {
        for (let j = i + 1; j < candidates.length; j++) {
          if (removed.has(j)) continue;
          const nameJ = candidates[j].mod.name.toLowerCase();
          if (exclusions.some(ex => nameJ.includes(ex))) {
            removed.add(j);
          }
        }
      }
    }
  }
  return candidates.filter((_, idx) => !removed.has(idx));
}

export function getKBSuggestions(
  detectedDomains: DetectedDomainInput[],
  mentionedEntities: string[],
  mentionedModules: string[],
): SuggestionResult {
  if (detectedDomains.length === 0 || detectedDomains[0].confidence < 0.3) {
    return {
      suggestions: UNIVERSAL_FALLBACK.slice(0, 6),
      headerText: 'Common features most apps include:',
      tracking: UNIVERSAL_FALLBACK.slice(0, 6).map(s => ({
        domain: 'universal',
        suggestion: s.name,
        shown: true,
        accepted: false,
        explicitlyRejected: false,
        timestamp: Date.now(),
      })),
    };
  }

  const primary = detectedDomains[0];
  const secondaries = primary.confidence >= 0.6
    ? detectedDomains.slice(1).filter(d => d.confidence >= 0.3)
    : [];

  const mentionedLower = new Set([
    ...mentionedEntities.map(e => e.toLowerCase()),
    ...mentionedModules.map(m => m.toLowerCase()),
  ]);

  const candidates: { mod: DomainModule; domainId: string; domainName: string; domainConfidence: number }[] = [];

  for (const mod of primary.domain.modules) {
    if (mentionedLower.has(mod.name.toLowerCase())) continue;
    const allEntitiesMentioned = mod.entities.length > 0 &&
      mod.entities.every(e => mentionedLower.has(e.toLowerCase()));
    if (allEntitiesMentioned) continue;
    candidates.push({
      mod,
      domainId: primary.domain.id,
      domainName: primary.domain.name,
      domainConfidence: primary.confidence,
    });
  }

  for (const sec of secondaries) {
    for (const mod of sec.domain.modules) {
      if (mentionedLower.has(mod.name.toLowerCase())) continue;
      const already = candidates.some(c => c.mod.name.toLowerCase() === mod.name.toLowerCase());
      if (already) continue;
      candidates.push({
        mod,
        domainId: sec.domain.id,
        domainName: sec.domain.name,
        domainConfidence: sec.confidence,
      });
    }
  }

  const compatible = filterIncompatible(candidates);

  const freq = getModuleFrequency();
  const maxFreq = Math.max(...freq.values(), 1);

  const scored: ScoredSuggestion[] = compatible.map(c => {
    const domainMatch = c.domainConfidence;

    const nameKey = c.mod.name.toLowerCase();
    const rawFreq = freq.get(nameKey) || 0;
    const commonality = rawFreq / maxFreq;

    const entityOverlap = c.mod.entities.length > 0
      ? c.mod.entities.filter(e => mentionedLower.has(e.toLowerCase())).length / c.mod.entities.length
      : 0;
    const missingCoverage = 1 - entityOverlap;

    const isGateway = GATEWAY_MODULES.has(nameKey) ? 1.0 : 0.0;
    const entitiesUnlock = c.mod.entities.length > 2 ? 0.5 : c.mod.entities.length > 0 ? 0.3 : 0.0;
    const dependency = Math.min(isGateway + entitiesUnlock, 1.0);

    const score =
      domainMatch * 0.4 +
      commonality * 0.25 +
      missingCoverage * 0.2 +
      dependency * 0.15;

    return {
      name: c.mod.name,
      description: c.mod.description,
      capabilityDescription: toCapabilityDescription(c.mod),
      entities: c.mod.entities,
      features: c.mod.pages.flatMap(p => p.features),
      pages: c.mod.pages.map(p => ({ name: p.name, features: p.features })),
      score,
      domainId: c.domainId,
      domainName: c.domainName,
      source: 'kb_suggestion' as const,
      confidence: 0.85,
      userConfirmed: false,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const maxItems = primary.confidence > 0.8 ? 7 : 6;
  const minItems = 6;

  let result: ScoredSuggestion[];
  if (secondaries.length > 0) {
    const primaryItems = scored.filter(s => s.domainId === primary.domain.id);
    const secondaryItems = scored.filter(s => s.domainId !== primary.domain.id);
    const targetSecondary = Math.min(2, Math.ceil(maxItems * 0.3));
    const secondarySlots = Math.min(secondaryItems.length, targetSecondary);
    const primarySlots = Math.min(primaryItems.length, maxItems - secondarySlots);
    result = [
      ...primaryItems.slice(0, primarySlots),
      ...secondaryItems.slice(0, secondarySlots),
    ].sort((a, b) => b.score - a.score).slice(0, maxItems);
  } else {
    result = scored.slice(0, maxItems);
  }

  if (result.length < minItems) {
    const existingNames = new Set(result.map(s => s.name.toLowerCase()));
    const fillers = UNIVERSAL_FALLBACK.filter(s => !existingNames.has(s.name.toLowerCase()));
    result = [...result, ...fillers.slice(0, minItems - result.length)];
  }

  const domainName = primary.domain.name.split('/')[0].trim();
  const headerText = primary.confidence > 0.8
    ? `Most teams building a ${domainName} app usually include:`
    : `You might want to consider:`;

  const tracking: SuggestionTrackingRecord[] = result.map(s => ({
    domain: s.domainId,
    suggestion: s.name,
    shown: true,
    accepted: false,
    explicitlyRejected: false,
    timestamp: Date.now(),
  }));

  return { suggestions: result, headerText, tracking };
}

export function formatSuggestionsSection(suggestionResult: SuggestionResult): string {
  if (suggestionResult.suggestions.length === 0) return '';

  const lines: string[] = [];
  lines.push(`\n### ${suggestionResult.headerText}\n`);

  for (let i = 0; i < suggestionResult.suggestions.length; i++) {
    const s = suggestionResult.suggestions[i];
    lines.push(`${i + 1}. **${s.name}**`);
    lines.push(`   ${s.capabilityDescription}`);
  }

  lines.push('\n_You can mention any of these by name to include them, or tell me what else you need._\n');

  return lines.join('\n');
}

export interface SuggestionMatch {
  suggestion: ScoredSuggestion;
  matchType: 'exact' | 'fuzzy_strong' | 'fuzzy_weak';
  confidence: number;
}

export function matchSuggestionsFromText(
  userText: string,
  shownSuggestions: ScoredSuggestion[],
): SuggestionMatch[] {
  const lower = userText.toLowerCase();
  const userTokens = lower.split(/[\s,;.!?]+/).filter(w => w.length > 2);
  const userStems = userTokens.map(stemWord);
  const matches: SuggestionMatch[] = [];

  const REJECT_PHRASES = ['not needed', 'don\'t need', 'dont need', 'skip', 'no need', 'remove', 'without', 'don\'t want', 'dont want', 'exclude', 'not interested'];

  for (const suggestion of shownSuggestions) {
    const rejectedCtx = REJECT_PHRASES.some(rp => {
      const idx = lower.indexOf(rp);
      if (idx < 0) return false;
      const surrounding = lower.slice(Math.max(0, idx - 30), idx + rp.length + 30);
      return surrounding.includes(suggestion.name.toLowerCase()) ||
        suggestion.entities.some(e => surrounding.includes(e.toLowerCase()));
    });
    if (rejectedCtx) continue;

    const moduleShape: DomainModule = {
      name: suggestion.name,
      description: suggestion.description,
      entities: suggestion.entities,
      pages: suggestion.pages.map(p => ({ name: p.name, path: '', description: '', features: p.features })),
    };
    const aliases = buildModuleAliases(moduleShape);

    const nameLower = suggestion.name.toLowerCase();
    if (lower.includes(nameLower)) {
      matches.push({ suggestion, matchType: 'exact', confidence: 0.95 });
      continue;
    }

    const nameWords = nameLower.split(/[\s&/,]+/).filter(w => w.length > 2);
    const allNameWordsPresent = nameWords.length > 0 && nameWords.every(w => lower.includes(w));
    if (allNameWordsPresent) {
      matches.push({ suggestion, matchType: 'exact', confidence: 0.95 });
      continue;
    }

    let aliasMatchCount = 0;
    let totalAliases = aliases.length;
    for (const alias of aliases) {
      if (lower.includes(alias)) {
        aliasMatchCount++;
        continue;
      }
      const aliasStem = stemWord(alias);
      if (userStems.includes(aliasStem)) {
        aliasMatchCount++;
      }
    }

    const matchScore = totalAliases > 0 ? aliasMatchCount / totalAliases : 0;

    if (matchScore > 0.65) {
      const entityMatch = suggestion.entities.some(e => lower.includes(e.toLowerCase()));
      if (matchScore > 0.8 || entityMatch) {
        matches.push({ suggestion, matchType: 'fuzzy_strong', confidence: 0.85 });
      } else {
        matches.push({ suggestion, matchType: 'fuzzy_weak', confidence: 0.7 });
      }
    }
  }

  return matches.filter(m => m.confidence >= 0.65);
}

export function detectRejectedSuggestions(
  userText: string,
  shownSuggestions: ScoredSuggestion[],
): ScoredSuggestion[] {
  const lower = userText.toLowerCase();

  const GLOBAL_REJECT = [
    'none of these', 'none of those', 'don\'t need any', 'dont need any',
    'skip all suggestions', 'no suggestions', 'don\'t include any',
    'dont include any', 'not interested in any', 'i don\'t want any of',
    'skip the suggestions', 'ignore suggestions', 'no thanks to all',
  ];
  const isGlobalReject = GLOBAL_REJECT.some(p => lower.includes(p));
  if (isGlobalReject) {
    return [...shownSuggestions];
  }

  const REJECT_PHRASES = ['not needed', 'don\'t need', 'dont need', 'skip', 'no need', 'remove', 'without', 'don\'t want', 'dont want', 'exclude', 'not interested'];
  const rejected: ScoredSuggestion[] = [];

  for (const suggestion of shownSuggestions) {
    const nameLower = suggestion.name.toLowerCase();
    for (const rp of REJECT_PHRASES) {
      const idx = lower.indexOf(rp);
      if (idx < 0) continue;
      const surrounding = lower.slice(Math.max(0, idx - 40), idx + rp.length + 40);
      if (surrounding.includes(nameLower) ||
          suggestion.entities.some(e => surrounding.includes(e.toLowerCase()))) {
        rejected.push(suggestion);
        break;
      }
    }
  }

  return rejected;
}

export function updateTrackingRecords(
  records: SuggestionTrackingRecord[],
  acceptedNames: string[],
  rejectedNames: string[],
): SuggestionTrackingRecord[] {
  const acceptedSet = new Set(acceptedNames.map(n => n.toLowerCase()));
  const rejectedSet = new Set(rejectedNames.map(n => n.toLowerCase()));

  return records.map(r => ({
    ...r,
    accepted: acceptedSet.has(r.suggestion.toLowerCase()) || r.accepted,
    explicitlyRejected: rejectedSet.has(r.suggestion.toLowerCase()) || r.explicitlyRejected,
  }));
}

export function computeAcceptanceStats(
  records: SuggestionTrackingRecord[],
): { acceptanceRate: number; conditionalAcceptance: Map<string, { shown: number; accepted: number; rate: number }> } {
  const shown = records.filter(r => r.shown).length;
  const accepted = records.filter(r => r.accepted).length;
  const acceptanceRate = shown > 0 ? accepted / shown : 0;

  const byDomainModule = new Map<string, { shown: number; accepted: number; rate: number }>();
  for (const r of records) {
    const key = `${r.domain}::${r.suggestion}`;
    const existing = byDomainModule.get(key) || { shown: 0, accepted: 0, rate: 0 };
    if (r.shown) existing.shown++;
    if (r.accepted) existing.accepted++;
    existing.rate = existing.shown > 0 ? existing.accepted / existing.shown : 0;
    byDomainModule.set(key, existing);
  }

  return { acceptanceRate, conditionalAcceptance: byDomainModule };
}

export function applyNegativeDecay(
  records: SuggestionTrackingRecord[],
  lambda: number = 0.001,
): Map<string, number> {
  const now = Date.now();
  const weights = new Map<string, number>();

  for (const r of records) {
    if (!r.explicitlyRejected && r.accepted) continue;
    const key = `${r.domain}::${r.suggestion}`;
    const timeDelta = (now - r.timestamp) / (1000 * 60 * 60);
    let weight = r.explicitlyRejected ? -1.0 : (r.shown && !r.accepted ? -0.2 : 0);
    weight *= Math.exp(-lambda * timeDelta);
    const existing = weights.get(key) || 0;
    weights.set(key, existing + weight);
  }

  return weights;
}
