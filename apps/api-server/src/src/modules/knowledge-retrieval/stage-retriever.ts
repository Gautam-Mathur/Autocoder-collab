/**
 * Stage Retriever — maps each pipeline stage to its knowledge slice
 *
 * This is the relevance gating layer. Every stage gets a strict profile
 * defining which chunk types it is allowed to see, what complexity ceiling
 * it has, and how many chunks to retrieve.
 *
 * Rules:
 *   - understanding: only domain + entity-archetype + workflow
 *   - architecture:  only patterns + concepts + best-practices (no stack code)
 *   - schema/api:    entity-archetypes + snippets for the chosen stack only
 *   - codegen:       stack chunks for chosen stack only — nothing else
 *   - quality:       anti-patterns only
 */

import { queryKnowledge, type QueryFilters } from './chunk-index.js';
import { buildContextBlock } from './context-compressor.js';
import type { ChunkType } from './chunk-extractor.js';

interface StageRetrievalProfile {
  allowedTypes: ChunkType[];
  filterCategory?: string[];
  maxComplexity?: 'simple' | 'moderate' | 'complex' | 'expert';
  topK: number;
  stackFiltered?: boolean;   // only retrieve chunks for chosen stack
  domainFiltered?: boolean;  // only retrieve chunks for detected domain
}

const STAGE_PROFILES: Record<string, StageRetrievalProfile> = {
  understand: {
    allowedTypes: ['domain', 'entity-archetype', 'workflow'],
    maxComplexity: 'moderate',
    topK: 5,
    domainFiltered: true,
  },
  plan: {
    allowedTypes: ['domain', 'entity-archetype', 'workflow'],
    maxComplexity: 'moderate',
    topK: 6,
    domainFiltered: true,
  },
  reason: {
    allowedTypes: ['entity-archetype', 'workflow', 'concept'],
    filterCategory: ['architecture', 'database', 'design'],
    maxComplexity: 'moderate',
    topK: 4,
    domainFiltered: true,
  },
  architect: {
    allowedTypes: ['pattern', 'concept', 'best-practice'],
    filterCategory: ['architecture', 'design', 'security', 'performance'],
    maxComplexity: 'complex',
    topK: 6,
  },
  design: {
    allowedTypes: ['concept', 'best-practice'],
    filterCategory: ['ux', 'accessibility', 'react'],
    maxComplexity: 'moderate',
    topK: 4,
  },
  specify: {
    allowedTypes: ['domain', 'entity-archetype', 'best-practice'],
    maxComplexity: 'moderate',
    topK: 5,
    domainFiltered: true,
  },
  schema: {
    allowedTypes: ['entity-archetype', 'snippet', 'best-practice', 'stack'],
    filterCategory: ['database', 'typescript', 'devops'],
    topK: 5,
    stackFiltered: true,
    domainFiltered: true,
  },
  api: {
    allowedTypes: ['snippet', 'best-practice', 'stack', 'concept'],
    filterCategory: ['security', 'performance', 'testing'],
    topK: 5,
    stackFiltered: true,
  },
  compose: {
    allowedTypes: ['concept', 'snippet', 'best-practice', 'stack'],
    filterCategory: ['react', 'ux', 'accessibility', 'typescript'],
    topK: 5,
    stackFiltered: true,
  },
  generate: {
    allowedTypes: ['stack', 'snippet', 'entity-archetype'],
    topK: 8,
    stackFiltered: true,
    domainFiltered: true,
  },
  quality: {
    allowedTypes: ['anti-pattern', 'best-practice'],
    topK: 10,
  },
  test: {
    allowedTypes: ['snippet', 'best-practice', 'stack'],
    filterCategory: ['testing'],
    topK: 4,
    stackFiltered: true,
  },
  validate: {
    allowedTypes: ['anti-pattern', 'best-practice'],
    filterCategory: ['typescript', 'security'],
    topK: 5,
  },
  'deep-quality': {
    allowedTypes: ['anti-pattern'],
    topK: 8,
  },
};

export async function retrieveForStage(params: {
  stageName: string;
  query: string;
  chosenStack?: string;
  detectedDomain?: string;
  slmEndpoint?: string;
}): Promise<string> {
  const { stageName, query, chosenStack, detectedDomain, slmEndpoint } = params;
  const profile = STAGE_PROFILES[stageName];

  // stages with no profile don't need retrieval (learn, resolve, record)
  if (!profile) return '';

  const filters: QueryFilters = {
    type: profile.allowedTypes,
    maxComplexity: profile.maxComplexity,
  };

  if (profile.filterCategory?.length) {
    filters.category = profile.filterCategory;
  }

  if (profile.stackFiltered && chosenStack) {
    filters.stack = chosenStack;
  }

  if (profile.domainFiltered && detectedDomain) {
    filters.domain = detectedDomain;
  }

  try {
    const chunks = await queryKnowledge({
      text: query,
      filters,
      topK: profile.topK,
      slmEndpoint,
    });

    return buildContextBlock(chunks, stageName);
  } catch (e) {
    console.warn(`[StageRetriever] Failed for stage "${stageName}":`, e);
    return '';
  }
}
