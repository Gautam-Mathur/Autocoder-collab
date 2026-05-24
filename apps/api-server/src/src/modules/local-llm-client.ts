// Local LLM Client - Uses Ollama or compatible local models
// Gemma is the PRIMARY model - free and open-source via Ollama

import {
  ENHANCED_CODE_SYSTEM_PROMPT,
  EDIT_CODE_PROMPT,
  FIX_CODE_PROMPT,
  UNDERSTAND_CODE_PROMPT
} from './llm-training-context';

export interface LocalLLMConfig {
  baseUrl: string;
  model: string;
  timeout: number;
}

export interface LocalLLMResponse {
  content: string;
  model: string;
  done: boolean;
}

export interface GemmaHealthStatus {
  ollamaAvailable: boolean;
  gemmaInstalled: boolean;
  gemmaModel: string | null;
  availableModels: string[];
  pullCommand: string | null;
}

const GEMMA_MODEL = process.env.LOCAL_LLM_MODEL || 'gemma2:9b';

const GEMMA_MODEL_PATTERNS = [
  'gemma2',
  'gemma3',
  'gemma:',
  'gemma2:',
  'gemma3:',
];

const DEFAULT_CONFIG: LocalLLMConfig = {
  baseUrl: process.env.LOCAL_LLM_URL || 'http://localhost:11434',
  model: GEMMA_MODEL,
  timeout: 120000,
};

export function getDefaultGemmaModel(): string {
  return GEMMA_MODEL;
}

export async function isLocalLLMAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${DEFAULT_CONFIG.baseUrl}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getAvailableModels(): Promise<string[]> {
  try {
    const response = await fetch(`${DEFAULT_CONFIG.baseUrl}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json() as { models?: Array<{ name: string }> };
    return data.models?.map((m) => m.name) || [];
  } catch {
    return [];
  }
}

function isGemmaModel(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return GEMMA_MODEL_PATTERNS.some(p => lower.includes(p));
}

export async function checkGemmaHealth(): Promise<GemmaHealthStatus> {
  const result: GemmaHealthStatus = {
    ollamaAvailable: false,
    gemmaInstalled: false,
    gemmaModel: null,
    availableModels: [],
    pullCommand: null,
  };

  try {
    const response = await fetch(`${DEFAULT_CONFIG.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      result.pullCommand = `ollama pull ${GEMMA_MODEL}`;
      return result;
    }

    result.ollamaAvailable = true;
    const data = await response.json() as { models?: Array<{ name: string }> };
    const models: string[] = data.models?.map((m) => m.name) || [];
    result.availableModels = models;

    const gemmaModels = models.filter(isGemmaModel);
    if (gemmaModels.length > 0) {
      result.gemmaInstalled = true;
      const exactMatch = gemmaModels.find(m => m === GEMMA_MODEL);
      result.gemmaModel = exactMatch || gemmaModels[0];
    } else {
      result.pullCommand = `ollama pull ${GEMMA_MODEL}`;
    }
  } catch {
    result.pullCommand = `ollama pull ${GEMMA_MODEL}`;
  }

  return result;
}

export function suggestPullGemma(): { command: string; instructions: string } {
  return {
    command: `ollama pull ${GEMMA_MODEL}`,
    instructions: [
      `To use Gemma as your primary AI model:`,
      `1. Install Ollama: https://ollama.com/download`,
      `2. Start Ollama: ollama serve`,
      `3. Pull the Gemma model: ollama pull ${GEMMA_MODEL}`,
      `4. AutoCoder will automatically detect and use Gemma`,
    ].join('\n'),
  };
}

export async function generateWithLocalLLM(
  prompt: string,
  systemPrompt: string,
  config: Partial<LocalLLMConfig> = {}
): Promise<string> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const response = await fetch(`${cfg.baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      prompt: `${systemPrompt}\n\nUser Request: ${prompt}`,
      stream: false,
      options: {
        temperature: 0.2,
        num_ctx: 8192,
        stop: ['```\n\n', '---END---'],
      },
    }),
    signal: AbortSignal.timeout(cfg.timeout),
  });

  if (!response.ok) {
    throw new Error(`Local LLM error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { response?: string };
  return data.response || '';
}

export function extractJSON(content: string): string | null {
  const jsonPatterns = [
    /```json\s*([\s\S]*?)```/,
    /```\s*([\s\S]*?)```/,
    /(\{[\s\S]*\})/,
  ];

  for (const pattern of jsonPatterns) {
    const match = content.match(pattern);
    if (match) {
      const candidate = match[1] || match[0];
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        const nestedMatch = candidate.match(/(\{[\s\S]*\})/);
        if (nestedMatch) {
          try {
            JSON.parse(nestedMatch[1]);
            return nestedMatch[1];
          } catch {}
        }
      }
    }
  }

  try {
    JSON.parse(content);
    return content;
  } catch {
    return null;
  }
}

export async function* streamWithLocalLLM(
  prompt: string,
  systemPrompt: string,
  config: Partial<LocalLLMConfig> = {}
): AsyncGenerator<string, void, unknown> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const response = await fetch(`${cfg.baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      prompt: `${systemPrompt}\n\nUser Request: ${prompt}`,
      stream: true,
      options: {
        temperature: 0.2,
        num_ctx: 8192,
      },
    }),
    signal: AbortSignal.timeout(cfg.timeout),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Local LLM error: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.response) {
          yield data.response;
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
  }
}

export { EDIT_CODE_PROMPT, FIX_CODE_PROMPT, UNDERSTAND_CODE_PROMPT };

export const LOCAL_CODE_SYSTEM_PROMPT = ENHANCED_CODE_SYSTEM_PROMPT;
