/**
 * Chunk Extractor — Converts the 172K-line knowledge base into atomic, queryable chunks.
 *
 * One chunk per: domain module, entity archetype, workflow, concept, anti-pattern,
 * code snippet, best-practice group (up to 5 per chunk), and stack concept.
 */

import {
  getAllEntityArchetypes,
  getAllAntiPatterns,
  getAllCodeSnippets,
  getBestPractices,
  searchConcepts,
} from '../knowledge-base.js';

import { getAllDomains } from '../domain-knowledge.js';

import {
  STACK_CONCEPTS,
  STACK_CODE_SNIPPETS,
  STACK_BEST_PRACTICES,
  STACK_ANTI_PATTERNS,
} from '../stack-knowledge-base.js';

export type ChunkType =
  | 'domain'
  | 'entity-archetype'
  | 'workflow'
  | 'pattern'
  | 'anti-pattern'
  | 'snippet'
  | 'best-practice'
  | 'concept'
  | 'stack';

export type ComplexityLevel = 'simple' | 'moderate' | 'complex' | 'expert';

export interface KnowledgeChunk {
  id: string;
  type: ChunkType;
  domain?: string;
  stack?: string;
  category?: string;
  complexity?: ComplexityLevel;
  tags: string[];
  content: string;
  tokenEstimate: number;
}

function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(36);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  return text.length > maxChars ? text.slice(0, maxChars) + '...' : text;
}

function difficultyToComplexity(d?: string): ComplexityLevel {
  if (d === 'beginner') return 'simple';
  if (d === 'intermediate') return 'moderate';
  if (d === 'advanced') return 'complex';
  return 'moderate';
}

// ── Domain chunks ─────────────────────────────────────────────────────────

function extractDomainChunks(): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const domains = getAllDomains();

  for (const domain of domains) {
    for (const mod of domain.modules) {
      const content = [
        `Domain: ${domain.name} — Module: ${mod.name}`,
        mod.description,
        `Entities: ${mod.entities.join(', ')}`,
        mod.pages
          .map(p => `  Page "${p.name}" (${p.path}): ${p.description}. Features: ${p.features.join(', ')}`)
          .join('\n'),
        mod.kpis?.length ? `KPIs: ${mod.kpis.join(', ')}` : '',
        domain.commonIntegrations?.length
          ? `Common integrations: ${domain.commonIntegrations.join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      chunks.push({
        id: hashId(`domain:${domain.id}:${mod.name}`),
        type: 'domain',
        domain: domain.id,
        tags: [
          domain.id,
          domain.name.toLowerCase(),
          mod.name.toLowerCase(),
          ...(domain.keywords ?? []).slice(0, 5),
        ],
        content: truncateToTokens(content, 700),
        tokenEstimate: estimateTokens(content),
      });
    }

    for (const wf of domain.workflows ?? []) {
      const content = [
        `Workflow: ${wf.name} (entity: ${wf.entity}, domain: ${domain.name})`,
        `States: ${wf.states.join(' → ')}`,
        `Transitions: ${wf.transitions
          .map(t => `${t.from} → ${t.to} via "${t.action}"${t.role ? ` (${t.role})` : ''}`)
          .join('; ')}`,
      ].join('\n');

      chunks.push({
        id: hashId(`workflow:${domain.id}:${wf.name}`),
        type: 'workflow',
        domain: domain.id,
        tags: [wf.name.toLowerCase(), wf.entity.toLowerCase(), domain.id, 'state-machine'],
        content: truncateToTokens(content, 400),
        tokenEstimate: estimateTokens(content),
      });
    }
  }

  return chunks;
}

// ── Entity archetypes ──────────────────────────────────────────────────────

function extractEntityArchetypeChunks(): KnowledgeChunk[] {
  return getAllEntityArchetypes().map(arch => {
    const content = [
      `Entity archetype: ${arch.name}${arch.domain ? ` (domain: ${arch.domain})` : ''}`,
      arch.description ?? '',
      arch.suggestedFields?.length
        ? `Fields: ${arch.suggestedFields.map((f: any) => `${f.name}: ${f.type}`).join(', ')}`
        : '',
      arch.commonFeatures?.length
        ? `Common features: ${arch.commonFeatures.join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      id: hashId(`entity-archetype:${arch.id ?? arch.name}`),
      type: 'entity-archetype' as ChunkType,
      domain: arch.domain,
      tags: [
        arch.name.toLowerCase(),
        arch.domain ?? 'general',
        'entity',
        'model',
        'schema',
      ],
      content: truncateToTokens(content, 500),
      tokenEstimate: estimateTokens(content),
    };
  });
}

// ── Concepts ───────────────────────────────────────────────────────────────

function extractConceptChunks(): KnowledgeChunk[] {
  // searchConcepts('') returns all concepts
  const allConcepts = searchConcepts('');
  return allConcepts.map(c => {
    const content = [
      `Concept: ${c.name} (${c.category})`,
      c.description ?? '',
      c.explanation ?? '',
      c.examples?.length
        ? `Examples:\n${c.examples
            .slice(0, 3)
            .map((e: string) => `  ${e}`)
            .join('\n')}`
        : '',
      c.relatedConcepts?.length ? `Related: ${c.relatedConcepts.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      id: hashId(`concept:${c.id ?? c.name}`),
      type: 'concept' as ChunkType,
      category: c.category,
      complexity: difficultyToComplexity(c.difficulty),
      tags: [
        c.name.toLowerCase(),
        c.category,
        ...(c.relatedConcepts ?? []).slice(0, 3),
      ],
      content: truncateToTokens(content, 600),
      tokenEstimate: estimateTokens(content),
    };
  });
}

// ── Best practices ─────────────────────────────────────────────────────────

function extractBestPracticeChunks(): KnowledgeChunk[] {
  const practices = getBestPractices();
  const chunks: KnowledgeChunk[] = [];
  const BATCH = 5;

  for (let i = 0; i < practices.length; i += BATCH) {
    const batch = practices.slice(i, i + BATCH);
    if (batch.length === 0) continue;
    const category = (batch[0] as any).category ?? 'general';

    const content = [
      `Best practices — ${category}:`,
      ...batch.map((p: any) =>
        `• ${p.title ?? p.name ?? ''}: ${p.description ?? p.explanation ?? ''}`
      ),
    ].join('\n');

    chunks.push({
      id: hashId(`best-practice:${category}:${i}`),
      type: 'best-practice',
      category,
      tags: [category, 'best-practice', 'guidelines'],
      content: truncateToTokens(content, 700),
      tokenEstimate: estimateTokens(content),
    });
  }

  return chunks;
}

// ── Anti-patterns ──────────────────────────────────────────────────────────

function extractAntiPatternChunks(): KnowledgeChunk[] {
  return getAllAntiPatterns().map((ap, i) => {
    const content = [
      `Anti-pattern: ${(ap as any).name ?? (ap as any).title ?? `#${i}`} (severity: ${(ap as any).severity ?? 'medium'})`,
      (ap as any).description ?? (ap as any).explanation ?? '',
      (ap as any).badExample ? `Bad:\n${(ap as any).badExample}` : '',
      (ap as any).goodExample ? `Good:\n${(ap as any).goodExample}` : '',
      (ap as any).fix ? `Fix: ${(ap as any).fix}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      id: hashId(`anti-pattern:${i}:${(ap as any).name ?? ''}`),
      type: 'anti-pattern' as ChunkType,
      category: (ap as any).category ?? 'general',
      complexity: ((ap as any).severity === 'high' ? 'complex' : 'moderate') as ComplexityLevel,
      tags: [
        'anti-pattern',
        (ap as any).category ?? 'general',
        (ap as any).severity ?? 'medium',
      ],
      content: truncateToTokens(content, 600),
      tokenEstimate: estimateTokens(content),
    };
  });
}

// ── Code snippets ──────────────────────────────────────────────────────────

function extractSnippetChunks(): KnowledgeChunk[] {
  return getAllCodeSnippets().map((s, i) => {
    const content = [
      `Code snippet: ${(s as any).title ?? `#${i}`} (${(s as any).language ?? 'typescript'})`,
      (s as any).description ?? '',
      (s as any).code ?? '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      id: hashId(`snippet:${i}:${(s as any).title ?? ''}`),
      type: 'snippet' as ChunkType,
      category: (s as any).category ?? 'general',
      tags: [
        (s as any).language ?? 'typescript',
        (s as any).category ?? 'general',
        'snippet',
        'code',
      ],
      content: truncateToTokens(content, 800),
      tokenEstimate: estimateTokens(content),
    };
  });
}

// ── Stack chunks ──────────────────────────────────────────────────────────

function detectStack(text: string): string | undefined {
  const t = text.toLowerCase();
  if (t.includes('mongoose') || t.includes('mongodb')) return 'mern';
  if (t.includes('django') || t.includes('pytest')) return 'django-react';
  if (t.includes('spring') || t.includes('@entity') || (t.includes('java') && t.includes('jpa'))) return 'spring-boot-react';
  if (t.includes('dotnet') || t.includes('c#') || t.includes('ef core')) return 'dotnet-react';
  if (t.includes('gin') || (t.includes('golang') && t.includes('gorm'))) return 'go-gin-react';
  if (t.includes('vite') || t.includes('drizzle') || t.includes('tsx')) return 'react-vite-express';
  return undefined;
}

function extractStackChunks(): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];

  for (const [id, c] of Object.entries(STACK_CONCEPTS)) {
    const stack = detectStack((c as any).description + ' ' + (c as any).explanation);
    const content = [
      `Stack concept: ${(c as any).name}${stack ? ` (${stack})` : ''}`,
      (c as any).description ?? '',
      ((c as any).explanation ?? '').slice(0, 400),
    ]
      .filter(Boolean)
      .join('\n');

    chunks.push({
      id: hashId(`stack-concept:${id}`),
      type: 'stack',
      stack,
      category: (c as any).category,
      tags: ['stack', stack ?? 'general', ((c as any).name ?? '').toLowerCase()],
      content: truncateToTokens(content, 500),
      tokenEstimate: estimateTokens(content),
    });
  }

  for (let i = 0; i < STACK_CODE_SNIPPETS.length; i++) {
    const s = STACK_CODE_SNIPPETS[i] as any;
    const stack = s.stack ?? detectStack((s.title ?? '') + (s.code ?? ''));
    const content = [
      `Stack snippet: ${s.title ?? `#${i}`}${stack ? ` (${stack})` : ''}`,
      s.description ?? '',
      (s.code ?? '').slice(0, 600),
    ]
      .filter(Boolean)
      .join('\n');

    chunks.push({
      id: hashId(`stack-snippet:${i}`),
      type: 'stack',
      stack,
      category: s.category ?? 'snippet',
      tags: ['stack', 'snippet', stack ?? 'general'],
      content: truncateToTokens(content, 800),
      tokenEstimate: estimateTokens(content),
    });
  }

  for (let i = 0; i < STACK_ANTI_PATTERNS.length; i++) {
    const ap = STACK_ANTI_PATTERNS[i] as any;
    const stack = detectStack(ap.description ?? '');
    const content = [
      `Stack anti-pattern: ${ap.name ?? `#${i}`}${stack ? ` (${stack})` : ''}`,
      ap.description ?? '',
      ap.fix ?? '',
    ]
      .filter(Boolean)
      .join('\n');

    chunks.push({
      id: hashId(`stack-ap:${i}`),
      type: 'stack',
      stack,
      category: 'anti-pattern',
      tags: ['stack', 'anti-pattern', stack ?? 'general'],
      content: truncateToTokens(content, 500),
      tokenEstimate: estimateTokens(content),
    });
  }

  return chunks;
}

// ── Main export ────────────────────────────────────────────────────────────

let _cachedChunks: KnowledgeChunk[] | null = null;

export function extractAllChunks(): KnowledgeChunk[] {
  if (_cachedChunks) return _cachedChunks;

  const chunks: KnowledgeChunk[] = [];

  const add = (label: string, fn: () => KnowledgeChunk[]) => {
    try {
      const result = fn();
      chunks.push(...result);
    } catch (e) {
      console.warn(`[ChunkExtractor] ${label} failed:`, e);
    }
  };

  add('domain', extractDomainChunks);
  add('entity-archetype', extractEntityArchetypeChunks);
  add('concept', extractConceptChunks);
  add('best-practice', extractBestPracticeChunks);
  add('anti-pattern', extractAntiPatternChunks);
  add('snippet', extractSnippetChunks);
  add('stack', extractStackChunks);

  _cachedChunks = chunks;
  console.log(`[ChunkExtractor] Extracted ${chunks.length} knowledge chunks`);
  return chunks;
}
