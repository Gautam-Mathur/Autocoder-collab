/**
 * Complexity Learning Store — persistent, file-backed memory of past
 * generation outcomes used to bias future complexity classification.
 *
 * We deliberately use a small JSON file (under `.local/`) rather than the
 * `@workspace/db` Drizzle schema because:
 *   - the production Drizzle schema in this branch is missing the tables
 *     the learning engine expects (e.g. `generationOutcomes`),
 *   - this store is a few-KB hot-path lookup, not a system-of-record,
 *   - keeping it on disk means it survives restarts without a DB roundtrip.
 *
 * Tokenization is intentionally simple: we strip stop-words, take unique
 * terms, and use Jaccard similarity. Good enough at the scale we care about
 * (a few hundred records); upgrade to TF-IDF/embedding lookup later if
 * needed.
 *
 * Public surface:
 *   - `recordComplexityOutcome({ signature, finalTier, fileCount, ... })`
 *   - `findSimilarComplexity(signature) -> { tier, confidence, sampleCount }`
 *   - `loadStoreForTesting() / clearStoreForTesting()` (test hooks)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export type StoredComplexityTier = 'minimal' | 'small' | 'medium' | 'large' | 'xl';

interface ComplexityRecord {
  signature: string;
  tokens: string[];
  finalTier: StoredComplexityTier;
  fileCount: number;
  lineCount: number;
  success: boolean;
  ts: number;
}

interface StoreShape {
  version: 1;
  records: ComplexityRecord[];
}

const STORE_PATH = join(process.cwd(), '.local', 'autocoder-complexity-learning.json');
const MAX_RECORDS = 500;

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','if','then','to','of','for','with','that','this',
  'is','are','was','were','be','been','being','it','its','as','at','by','on','in',
  'we','you','i','my','your','our','their','they','them','he','she','his','her',
  'app','application','make','build','create','please','want','need','simple','basic',
]);

function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOP_WORDS.has(raw)) continue;
    out.add(raw);
  }
  return Array.from(out);
}

let cache: StoreShape | null = null;

function loadStore(): StoreShape {
  if (cache) return cache;
  if (!existsSync(STORE_PATH)) {
    cache = { version: 1, records: [] };
    return cache;
  }
  try {
    const raw = readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as StoreShape;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('bad shape');
    cache = parsed;
    return cache;
  } catch {
    cache = { version: 1, records: [] };
    return cache;
  }
}

function persistStore(store: StoreShape): void {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch (err) {
    // Best-effort persistence — never block the pipeline on a bad disk.
    console.warn('[ComplexityLearningStore] persist failed (non-fatal):', err);
  }
}

export interface OutcomeInput {
  signature: string;
  finalTier: StoredComplexityTier;
  fileCount: number;
  lineCount: number;
  success: boolean;
}

export function recordComplexityOutcome(o: OutcomeInput): void {
  const store = loadStore();
  store.records.push({
    signature: o.signature,
    tokens: tokenize(o.signature),
    finalTier: o.finalTier,
    fileCount: o.fileCount,
    lineCount: o.lineCount,
    success: o.success,
    ts: Date.now(),
  });
  // Cap the file size — drop oldest beyond MAX_RECORDS.
  if (store.records.length > MAX_RECORDS) {
    store.records.splice(0, store.records.length - MAX_RECORDS);
  }
  persistStore(store);
}

export interface SimilarityResult {
  tier: StoredComplexityTier;
  confidence: number;     // 0–1, blends sample count and tier-vote agreement
  sampleCount: number;
  topSimilarity: number;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let inter = 0;
  for (const t of a) if (setB.has(t)) inter++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

export function findSimilarComplexity(signature: string): SimilarityResult | null {
  const store = loadStore();
  if (store.records.length === 0) return null;

  const tokens = tokenize(signature);
  const scored = store.records
    .map((r) => ({ r, sim: jaccard(tokens, r.tokens) }))
    .filter((s) => s.sim >= 0.4)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 8);

  if (scored.length === 0) return null;

  // Vote on the tier. Weight successful runs more than failed ones.
  const votes: Record<StoredComplexityTier, number> = { minimal: 0, small: 0, medium: 0, large: 0, xl: 0 };
  let totalWeight = 0;
  for (const { r, sim } of scored) {
    const w = sim * (r.success ? 1.0 : 0.4);
    votes[r.finalTier] += w;
    totalWeight += w;
  }
  const winner = (Object.entries(votes) as Array<[StoredComplexityTier, number]>)
    .sort((a, b) => b[1] - a[1])[0];
  const tier = winner[0];
  const winnerWeight = winner[1];

  // Confidence = (winner share) * sigmoid(sample count). Caps at ~0.95.
  const share = totalWeight > 0 ? winnerWeight / totalWeight : 0;
  const sampleBoost = scored.length / (scored.length + 3);
  const confidence = Math.min(0.95, share * sampleBoost + 0.05);

  return {
    tier,
    confidence,
    sampleCount: scored.length,
    topSimilarity: scored[0].sim,
  };
}

// ── Test hooks ────────────────────────────────────────────────────────────
export function clearStoreForTesting(): void {
  cache = { version: 1, records: [] };
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2));
  } catch {}
}

export function loadStoreForTesting(): StoreShape {
  cache = null;
  return loadStore();
}
