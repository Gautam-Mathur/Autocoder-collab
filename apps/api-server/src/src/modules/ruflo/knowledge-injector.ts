/**
 * RuFlo Fusion — Knowledge Base injection guard
 *
 * KB context is allowed only for Planner and Architect. Other agents (System,
 * Designer, Coder, Debugger, Reviewer, Tester, Security) get null. The cap
 * is 500 tokens (~2000 chars) — anything beyond that causes drift in
 * downstream code generation.
 */

import { logEvent } from './observability-sink.js';
import type { AgentName } from './types.js';

export const KB_TOKEN_CAP = 500;
export const KB_CHAR_CAP = KB_TOKEN_CAP * 4;

const ALLOWED: ReadonlySet<AgentName> = new Set<AgentName>(['Planner', 'Architect']);

/**
 * Returns truncated KB context for the given agent, or null if the agent is
 * not allowed to receive KB context. The fetcher is injected so the caller
 * can pass any function — typically a wrapper around knowledge-base.ts's
 * getContextForGeneration().
 */
export async function injectKnowledge(
  agent: AgentName,
  query: string,
  fetcher: (q: string) => Promise<string> | string,
): Promise<string | null> {
  if (!ALLOWED.has(agent)) {
    logEvent({ type: 'kb_blocked', agent, reason: 'not_in_allowed_phase' });
    return null;
  }
  let raw = '';
  try {
    raw = (await fetcher(query)) ?? '';
  } catch {
    raw = '';
  }
  const capped = summarizeToTokenCap(raw, KB_TOKEN_CAP);
  const tokenCount = Math.ceil(capped.length / 4);
  logEvent({ type: 'kb_injected', agent, tokenCount });
  return capped;
}

export function summarizeToTokenCap(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n// [KB truncated at ' + maxTokens + '-token cap]';
}
