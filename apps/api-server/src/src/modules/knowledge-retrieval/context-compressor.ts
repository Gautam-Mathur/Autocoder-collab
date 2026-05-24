/**
 * Context Compressor — keeps injected context under a token budget per stage
 *
 * Strategy:
 *   1. Remove duplicate concepts
 *   2. Strip code examples from non-codegen stages
 *   3. Truncate individual chunks if still over budget
 */

import type { KnowledgeChunk } from './chunk-extractor.js';

const MAX_TOKENS_PER_STAGE = 2000;
const CHARS_PER_TOKEN = 4;

function countTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function stripCode(content: string): string {
  // Remove lines that look like code (indented 2+ spaces, backtick blocks)
  return content
    .replace(/```[\s\S]*?```/g, '[code example omitted]')
    .replace(/`[^`]+`/g, '[inline code]')
    .replace(/\n {4,}[^\n]+/g, '');
}

export function compressContext(
  chunks: KnowledgeChunk[],
  stage: string,
  maxTokens: number = MAX_TOKENS_PER_STAGE
): string {
  const isCodegenStage = ['codegen', 'generate', 'schema', 'api'].includes(stage);

  // Deduplicate by content similarity (simple prefix match)
  const seen = new Set<string>();
  const deduped: KnowledgeChunk[] = [];
  for (const chunk of chunks) {
    const key = chunk.content.slice(0, 80).toLowerCase().replace(/\s+/g, ' ');
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(chunk);
    }
  }

  // Build context string chunk by chunk, respecting the token budget
  const parts: string[] = [];
  let usedTokens = 0;

  for (const chunk of deduped) {
    let text = isCodegenStage ? chunk.content : stripCode(chunk.content);
    const tokens = countTokens(text);

    if (usedTokens + tokens > maxTokens) {
      const remaining = maxTokens - usedTokens;
      if (remaining < 50) break;
      text = text.slice(0, remaining * CHARS_PER_TOKEN) + '...';
    }

    parts.push(text);
    usedTokens += countTokens(text);
    if (usedTokens >= maxTokens) break;
  }

  return parts.join('\n\n---\n\n');
}

export function buildContextBlock(chunks: KnowledgeChunk[], stage: string): string {
  if (chunks.length === 0) return '';
  const compressed = compressContext(chunks, stage);
  if (!compressed.trim()) return '';
  return `\n\n=== KNOWLEDGE CONTEXT (${stage} stage) ===\n${compressed}\n=== END KNOWLEDGE CONTEXT ===\n`;
}
