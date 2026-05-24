import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionCreateParamsNonStreaming, ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import {
  generateWithLocalLLM,
  checkGemmaHealth,
  isLocalLLMAvailable,
  getDefaultGemmaModel,
} from "./local-llm-client";
import type { GemmaHealthStatus } from "./local-llm-client";

export interface GemmaHints {
  partialOutput: string | null;
  promptUsed: string;
  systemPromptUsed: string;
  errorMessage: string | null;
  gemmaModel: string;
}

export interface ProviderResult {
  content: string;
  source: "gemma" | "cloud";
  gemmaHints: GemmaHints | null;
  model: string;
  latencyMs: number;
}

export interface ProviderStatus {
  primary: {
    name: string;
    model: string;
    available: boolean;
    gemmaHealth: GemmaHealthStatus;
  };
  fallback: {
    name: string;
    model: string;
    available: boolean;
  };
}

const DEFAULT_CLOUD_MODEL = "gpt-4o";

export type ProviderMode = "auto" | "cloud" | "local";

let cloudConfig = {
  apiKey: "",
  baseUrl: "",
  model: DEFAULT_CLOUD_MODEL,
};

let providerMode: ProviderMode = "auto";

let openaiClient: OpenAI | null = null;

function isLocalOnlyModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes('gemma') || lower.includes('qwen') || lower.includes('llama') || lower.includes('mistral') || lower.includes('phi');
}

const LOCAL_PLACEHOLDER_KEYS = new Set(["", "ollama", "lm-studio", "lmstudio", "not-needed", "none", "local", "placeholder"]);

function looksLikeLocalUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.includes("localhost") || lower.includes("127.0.0.1") || lower.includes("0.0.0.0") || lower.includes("host.docker.internal");
}

function looksLikeRealCloudKey(key: string): boolean {
  if (!key) return false;
  if (LOCAL_PLACEHOLDER_KEYS.has(key.trim().toLowerCase())) return false;
  return key.trim().length >= 16;
}

/** When mode='auto', decide whether the configured cloud key is a "real" cloud key
 *  (skip local Gemma) vs a local-server placeholder (use Gemma first). */
export function shouldSkipGemmaAuto(): boolean {
  if (!looksLikeRealCloudKey(cloudConfig.apiKey)) return false;
  if (looksLikeLocalUrl(cloudConfig.baseUrl)) return false;
  return true;
}

export function setProviderMode(mode: ProviderMode) {
  providerMode = mode;
}

export function getProviderMode(): ProviderMode {
  return providerMode;
}

export function getEffectiveProviderMode(): "cloud" | "local" | "auto" {
  if (providerMode !== "auto") return providerMode;
  return shouldSkipGemmaAuto() ? "cloud" : "local";
}

export function configureCloudFallback(cfg: { apiKey?: string; baseUrl?: string; model?: string }) {
  if (cfg.apiKey !== undefined) cloudConfig.apiKey = cfg.apiKey;
  if (cfg.baseUrl !== undefined) cloudConfig.baseUrl = cfg.baseUrl;
  if (cfg.model !== undefined) {
    cloudConfig.model = isLocalOnlyModel(cfg.model) ? DEFAULT_CLOUD_MODEL : cfg.model;
  }

  if (cloudConfig.apiKey) {
    openaiClient = new OpenAI({
      apiKey: cloudConfig.apiKey,
      ...(cloudConfig.baseUrl ? { baseURL: cloudConfig.baseUrl } : {}),
    });
  } else {
    openaiClient = null;
  }
}

export function getCloudClient(): OpenAI | null {
  return openaiClient;
}

export function getCloudModel(): string {
  return cloudConfig.model;
}

export function hasCloudFallback(): boolean {
  return openaiClient !== null && !!cloudConfig.apiKey;
}

function buildFallbackPromptWithHints(
  prompt: string,
  systemPrompt: string,
  hints: GemmaHints
): { enhancedPrompt: string; enhancedSystem: string } {
  let enhancedSystem = systemPrompt;

  if (hints.partialOutput) {
    enhancedSystem += `\n\nNote: A local AI model (${hints.gemmaModel}) attempted this task but produced an incomplete result. Here is what it generated so far — use it as a starting point and improve upon it:\n---\n${hints.partialOutput.substring(0, 2000)}\n---`;
  }

  if (hints.errorMessage) {
    enhancedSystem += `\n\nThe local model encountered this error: ${hints.errorMessage}. Please ensure your response avoids this issue.`;
  }

  return {
    enhancedPrompt: prompt,
    enhancedSystem,
  };
}

function buildGemmaHints(
  prompt: string,
  systemPrompt: string,
  errorMessage: string,
  partialOutput: string | null = null
): GemmaHints {
  return {
    partialOutput,
    promptUsed: prompt,
    systemPromptUsed: systemPrompt,
    errorMessage,
    gemmaModel: getDefaultGemmaModel(),
  };
}

async function tryGemma(
  prompt: string,
  systemPrompt: string,
  timeout: number
): Promise<{ success: true; content: string } | { success: false; hints: GemmaHints }> {
  const gemmaModel = getDefaultGemmaModel();

  try {
    const localAvailable = await isLocalLLMAvailable();

    if (!localAvailable) {
      return {
        success: false,
        hints: buildGemmaHints(prompt, systemPrompt, "Ollama not available or Gemma model not installed"),
      };
    }

    const gemmaResponse = await generateWithLocalLLM(prompt, systemPrompt, {
      model: gemmaModel,
      timeout,
    });

    if (gemmaResponse && gemmaResponse.trim().length > 0) {
      return { success: true, content: gemmaResponse };
    }

    return {
      success: false,
      hints: buildGemmaHints(prompt, systemPrompt, "Gemma returned empty response", gemmaResponse || null),
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`[Gemma Provider] Gemma failed, falling back to cloud: ${errorMsg}`);
    return {
      success: false,
      hints: buildGemmaHints(prompt, systemPrompt, errorMsg),
    };
  }
}

function buildCloudMessages(
  prompt: string,
  systemPrompt: string,
  gemmaHints: GemmaHints | null
): ChatCompletionMessageParam[] {
  const { enhancedPrompt, enhancedSystem } = gemmaHints
    ? buildFallbackPromptWithHints(prompt, systemPrompt, gemmaHints)
    : { enhancedPrompt: prompt, enhancedSystem: systemPrompt };

  return [
    { role: "system" as const, content: enhancedSystem },
    { role: "user" as const, content: enhancedPrompt },
  ];
}

export async function generateWithProvider(
  prompt: string,
  systemPrompt: string,
  options: {
    maxTokens?: number;
    temperature?: number;
    jsonMode?: boolean;
    timeout?: number;
    skipGemma?: boolean;
  } = {}
): Promise<ProviderResult> {
  const startMs = Date.now();
  const gemmaModel = getDefaultGemmaModel();
  let gemmaHints: GemmaHints | null = null;

  // Honor runtime provider mode: 'cloud' or 'auto' with a real cloud key → skip Gemma entirely
  const effectiveMode = getEffectiveProviderMode();
  const skipGemma = options.skipGemma === true || effectiveMode === "cloud";

  if (!skipGemma) {
    const gemmaResult = await tryGemma(prompt, systemPrompt, options.timeout || 120000);
    if (gemmaResult.success) {
      return {
        content: gemmaResult.content,
        source: "gemma",
        gemmaHints: null,
        model: gemmaModel,
        latencyMs: Date.now() - startMs,
      };
    }
    gemmaHints = gemmaResult.hints;
  }

  if (!openaiClient || !cloudConfig.apiKey) {
    const pullInfo = `Gemma is not available. Install Ollama and run: ollama pull ${gemmaModel}`;
    throw new Error(
      gemmaHints?.errorMessage
        ? `${gemmaHints.errorMessage}. No cloud fallback configured. ${pullInfo}`
        : `No AI available. ${pullInfo}`
    );
  }

  console.log(`[Gemma Provider] Falling back to cloud AI (${cloudConfig.model})${gemmaHints ? " with Gemma hints" : ""}`);

  const messages = buildCloudMessages(prompt, systemPrompt, gemmaHints);

  const params: ChatCompletionCreateParamsNonStreaming = {
    model: cloudConfig.model,
    messages,
    max_completion_tokens: options.maxTokens || 4000,
    temperature: options.temperature ?? 0.2,
    ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
  };

  const completion = await openaiClient.chat.completions.create(params);
  const content = completion.choices?.[0]?.message?.content || "";

  return {
    content,
    source: "cloud",
    gemmaHints,
    model: cloudConfig.model,
    latencyMs: Date.now() - startMs,
  };
}

export interface StreamProviderResult {
  source: "gemma" | "cloud";
  stream?: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
  localContent?: string;
  gemmaHints: GemmaHints | null;
  model: string;
}

export async function generateStreamWithProvider(
  prompt: string,
  systemPrompt: string,
  options: {
    maxTokens?: number;
    temperature?: number;
    jsonMode?: boolean;
    timeout?: number;
  } = {}
): Promise<StreamProviderResult> {
  const gemmaModel = getDefaultGemmaModel();

  const effectiveMode = getEffectiveProviderMode();
  const skipGemma = effectiveMode === "cloud";

  let gemmaHints: GemmaHints | null = null;
  if (!skipGemma) {
    const gemmaResult = await tryGemma(prompt, systemPrompt, options.timeout || 120000);
    if (gemmaResult.success) {
      return {
        source: "gemma",
        localContent: gemmaResult.content,
        gemmaHints: null,
        model: gemmaModel,
      };
    }
    gemmaHints = gemmaResult.hints;
  }

  if (!openaiClient || !cloudConfig.apiKey) {
    throw new Error(`No AI available. Install Ollama and run: ollama pull ${gemmaModel}`);
  }

  const messages = buildCloudMessages(prompt, systemPrompt, gemmaHints);

  const params: ChatCompletionCreateParamsStreaming = {
    model: cloudConfig.model,
    messages,
    max_completion_tokens: options.maxTokens || 16000,
    stream: true,
    temperature: options.temperature ?? 0.2,
    ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
  };

  const stream = await openaiClient.chat.completions.create(params);

  return {
    source: "cloud",
    stream,
    gemmaHints,
    model: cloudConfig.model,
  };
}

export async function getProviderStatus(): Promise<ProviderStatus> {
  const gemmaHealth = await checkGemmaHealth();

  return {
    primary: {
      name: "Gemma (Local via Ollama)",
      model: gemmaHealth.gemmaModel || getDefaultGemmaModel(),
      available: gemmaHealth.ollamaAvailable && gemmaHealth.gemmaInstalled,
      gemmaHealth,
    },
    fallback: {
      name: "Cloud AI (OpenAI-compatible)",
      model: cloudConfig.model,
      available: hasCloudFallback(),
    },
  };
}
