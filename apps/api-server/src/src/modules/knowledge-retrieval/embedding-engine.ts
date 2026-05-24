/**
 * Embedding Engine — Semantic similarity for knowledge retrieval
 *
 * Two adapters:
 *   ModelEmbeddingEngine  — calls a connected Ollama/LM Studio embedding API
 *   NGramFallbackEngine   — character n-gram cosine similarity (always available)
 *
 * Factory: createEmbeddingEngine() returns the best available adapter.
 */

export interface EmbeddingEngine {
  embed(text: string): Promise<number[]>;
  cosineSimilarity(a: number[], b: number[]): number;
  isModelBacked: boolean;
}

// ── Model-backed embedding (Ollama/OpenAI-compatible) ─────────────────────

class ModelEmbeddingEngine implements EmbeddingEngine {
  readonly isModelBacked = true;

  constructor(private endpoint: string) {}

  async embed(text: string): Promise<number[]> {
    const truncated = text.slice(0, 2000);
    // Try OpenAI-compatible endpoint first (/v1/embeddings), then Ollama (/api/embeddings)
    const urls = [
      `${this.endpoint}/v1/embeddings`,
      `${this.endpoint}/api/embeddings`,
    ];

    for (const url of urls) {
      try {
        const body = url.includes('/v1/')
          ? JSON.stringify({ input: truncated, model: 'text-embedding-ada-002' })
          : JSON.stringify({ model: 'nomic-embed-text', prompt: truncated });

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) continue;
        const json = await res.json() as any;

        // OpenAI format
        if (json?.data?.[0]?.embedding) return json.data[0].embedding as number[];
        // Ollama format
        if (json?.embedding) return json.embedding as number[];
      } catch {
        // try next url
      }
    }
    throw new Error('Model embedding failed on all endpoints');
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}

// ── N-gram fallback (no model required) ──────────────────────────────────

class NGramFallbackEngine implements EmbeddingEngine {
  readonly isModelBacked = false;
  private readonly N = 3;
  private readonly DIMS = 1024;

  private getNgrams(text: string): Map<string, number> {
    const norm = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
    const counts = new Map<string, number>();
    for (let i = 0; i <= norm.length - this.N; i++) {
      const g = norm.slice(i, i + this.N);
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    // Also add word-level unigrams (boosted weight)
    for (const word of norm.split(/\s+/).filter(w => w.length > 2)) {
      counts.set(`W:${word}`, (counts.get(`W:${word}`) ?? 0) + 3);
    }
    return counts;
  }

  private hashToIndex(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
      h = h >>> 0;
    }
    return h % this.DIMS;
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Float64Array(this.DIMS);
    const grams = this.getNgrams(text);
    for (const [gram, count] of grams) {
      vec[this.hashToIndex(gram)] += count;
    }
    // L2-normalize
    let norm = 0;
    for (let i = 0; i < this.DIMS; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < this.DIMS; i++) vec[i] /= norm;
    return Array.from(vec);
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return Math.max(0, Math.min(1, dot));
  }
}

// ── Singleton cache ────────────────────────────────────────────────────────

let _engine: EmbeddingEngine | null = null;
let _endpointUsed: string | null = null;

export function createEmbeddingEngine(slmEndpoint?: string): EmbeddingEngine {
  if (_engine && _endpointUsed === (slmEndpoint ?? null)) return _engine;

  if (slmEndpoint) {
    _engine = new ModelEmbeddingEngine(slmEndpoint);
    _endpointUsed = slmEndpoint;
    console.log('[EmbeddingEngine] Using model-backed embedding:', slmEndpoint);
  } else {
    _engine = new NGramFallbackEngine();
    _endpointUsed = null;
    console.log('[EmbeddingEngine] Using n-gram fallback embedding');
  }
  return _engine;
}

export function resetEmbeddingEngine(): void {
  _engine = null;
  _endpointUsed = null;
}
