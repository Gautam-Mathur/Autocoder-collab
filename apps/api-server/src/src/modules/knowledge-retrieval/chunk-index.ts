/**
 * Chunk Index — Two-stage hybrid retrieval
 *
 * Stage 1: BM25 pre-filter (fast, deterministic)
 *   Applies metadata hard-filters, then BM25 scoring to narrow 
 *   all chunks → top 50 candidates.
 *
 * Stage 2: Embedding rerank (always runs)
 *   Uses ModelEmbeddingEngine if SLM connected, else NGramFallbackEngine.
 *   Cosine-sorts the 50 candidates → returns top K.
 */

import { extractAllChunks, type KnowledgeChunk, type ChunkType } from './chunk-extractor.js';
import { createEmbeddingEngine } from './embedding-engine.js';

export interface QueryFilters {
  type?: ChunkType[];
  domain?: string;
  stack?: string;
  category?: string[];
  maxComplexity?: 'simple' | 'moderate' | 'complex' | 'expert';
}

export interface QueryParams {
  text: string;
  filters?: QueryFilters;
  topK: number;
  slmEndpoint?: string;
}

const COMPLEXITY_ORDER = ['simple', 'moderate', 'complex', 'expert'];

function complexityScore(c?: string): number {
  const idx = COMPLEXITY_ORDER.indexOf(c ?? 'simple');
  return idx === -1 ? 0 : idx;
}

// ── BM25 implementation ───────────────────────────────────────────────────

interface BM25Index {
  chunks: KnowledgeChunk[];
  invertedIndex: Map<string, number[]>; // term → chunk indices
  docLengths: number[];
  avgDocLength: number;
  idf: Map<string, number>;
}

function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function buildBM25Index(chunks: KnowledgeChunk[]): BM25Index {
  const invertedIndex = new Map<string, number[]>();
  const docLengths: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const tokens = tokenize(chunks[i].content + ' ' + chunks[i].tags.join(' '));
    docLengths.push(tokens.length);

    const seen = new Set<string>();
    for (const t of tokens) {
      if (!seen.has(t)) {
        if (!invertedIndex.has(t)) invertedIndex.set(t, []);
        invertedIndex.get(t)!.push(i);
        seen.add(t);
      }
    }
  }

  const avgDocLength = docLengths.reduce((a, b) => a + b, 0) / Math.max(1, docLengths.length);
  const N = chunks.length;
  const idf = new Map<string, number>();
  for (const [term, docs] of invertedIndex) {
    idf.set(term, Math.log((N - docs.length + 0.5) / (docs.length + 0.5) + 1));
  }

  return { chunks, invertedIndex, docLengths, avgDocLength, idf };
}

function bm25Score(index: BM25Index, chunkIdx: number, queryTerms: string[]): number {
  const K1 = 1.5, B = 0.75;
  const dl = index.docLengths[chunkIdx];
  const avgdl = index.avgDocLength;
  let score = 0;

  const contentTokens = tokenize(
    index.chunks[chunkIdx].content + ' ' + index.chunks[chunkIdx].tags.join(' ')
  );
  const termFreq = new Map<string, number>();
  for (const t of contentTokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);

  for (const term of queryTerms) {
    const tf = termFreq.get(term) ?? 0;
    if (tf === 0) continue;
    const idfVal = index.idf.get(term) ?? 0;
    score += idfVal * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (dl / avgdl))));
  }

  return score;
}

// ── Filter application ─────────────────────────────────────────────────────

function passesFilters(chunk: KnowledgeChunk, filters?: QueryFilters): boolean {
  if (!filters) return true;
  if (filters.type?.length && !filters.type.includes(chunk.type)) return false;

  if (filters.domain) {
    if (chunk.domain && chunk.domain !== filters.domain) return false;
  }

  if (filters.stack) {
    if (chunk.stack && chunk.stack !== filters.stack) return false;
    if (chunk.type === 'stack' && !chunk.stack) {
      // stack chunks without a detected stack — allow through
    }
  }

  if (filters.category?.length && chunk.category) {
    if (!filters.category.includes(chunk.category)) return false;
  }

  if (filters.maxComplexity && chunk.complexity) {
    if (complexityScore(chunk.complexity) > complexityScore(filters.maxComplexity)) return false;
  }

  return true;
}

// ── Main index class ───────────────────────────────────────────────────────

class KnowledgeIndex {
  private bm25!: BM25Index;
  private built = false;

  build(): void {
    if (this.built) return;
    const chunks = extractAllChunks();
    this.bm25 = buildBM25Index(chunks);
    this.built = true;
    console.log(`[KnowledgeIndex] BM25 index built — ${chunks.length} chunks`);
  }

  async query(params: QueryParams): Promise<KnowledgeChunk[]> {
    if (!this.built) this.build();

    const { text, filters, topK, slmEndpoint } = params;
    const chunks = this.bm25.chunks;

    // Stage 1: metadata filter
    const candidates = chunks
      .map((_, i) => i)
      .filter(i => passesFilters(chunks[i], filters));

    if (candidates.length === 0) return [];

    // Stage 1: BM25 score top 50
    const queryTerms = tokenize(text);
    const scored = candidates.map(i => ({
      idx: i,
      score: bm25Score(this.bm25, i, queryTerms),
    }));
    scored.sort((a, b) => b.score - a.score);
    const top50 = scored.slice(0, 50).map(s => s.idx);

    // Stage 2: embedding rerank
    try {
      const engine = createEmbeddingEngine(slmEndpoint);
      const queryVec = await engine.embed(text);
      const chunkVecs = await Promise.all(top50.map(i => engine.embed(chunks[i].content.slice(0, 800))));

      const reranked = top50.map((idx, pos) => ({
        idx,
        sim: engine.cosineSimilarity(queryVec, chunkVecs[pos]),
      }));
      reranked.sort((a, b) => b.sim - a.sim);

      return reranked.slice(0, topK).map(r => chunks[r.idx]);
    } catch (e) {
      console.warn('[KnowledgeIndex] Embedding rerank failed, falling back to BM25 order:', e);
      return top50.slice(0, topK).map(i => chunks[i]);
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

const _index = new KnowledgeIndex();

export function buildKnowledgeIndex(): void {
  _index.build();
}

export async function queryKnowledge(params: QueryParams): Promise<KnowledgeChunk[]> {
  return _index.query(params);
}
