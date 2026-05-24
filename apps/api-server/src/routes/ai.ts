import { Router } from "express";
import {
  getProviderStatus,
  configureCloudFallback,
  hasCloudFallback,
  setProviderMode,
  getProviderMode,
  getEffectiveProviderMode,
  type ProviderMode,
} from "../src/modules/gemma-provider";
import { suggestPullGemma, getDefaultGemmaModel } from "../src/modules/local-llm-client";

const router = Router();

const PLACEHOLDER_KEYS = new Set([
  "",
  "ollama",
  "lm-studio",
  "lmstudio",
  "not-needed",
  "none",
  "local",
  "placeholder",
]);

const LOCAL_ONLY_MODEL_PREFIXES = ["gemma", "qwen", "llama", "mistral", "phi", "deepseek", "codestral"];

function isPlaceholderKey(key: string | null | undefined): boolean {
  if (!key) return true;
  return PLACEHOLDER_KEYS.has(key.trim().toLowerCase());
}

function isLocalOnlyModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return LOCAL_ONLY_MODEL_PREFIXES.some((p) => m.startsWith(p));
}

function defaultBaseUrl(): string | null {
  return process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || null;
}

function defaultApiKey(): string | null {
  return process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || null;
}

let runtimeConfig: {
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
  providerMode: ProviderMode;
} = {
  baseUrl: defaultBaseUrl(),
  apiKey: defaultApiKey(),
  model: process.env.OPENAI_MODEL || "gpt-4o",
  providerMode: ((process.env.AI_PROVIDER_MODE as ProviderMode) || "auto") as ProviderMode,
};

function applyConfigToProvider() {
  setProviderMode(runtimeConfig.providerMode);
  const key = runtimeConfig.apiKey;
  const url = runtimeConfig.baseUrl;
  const model = runtimeConfig.model;
  if (key && !isPlaceholderKey(key) && url) {
    const cloudModel =
      runtimeConfig.providerMode === "cloud" && isLocalOnlyModel(model) ? "gpt-4o" : model;
    configureCloudFallback({ apiKey: key, baseUrl: url, model: cloudModel });
  } else {
    configureCloudFallback({ apiKey: "", baseUrl: "", model: "" });
  }
  console.log(
    `[AI Config] Reconfigured — endpoint=${url || "(default)"}, model=${model}, ` +
      `hasKey=${!!key && !isPlaceholderKey(key)}, mode=${runtimeConfig.providerMode}, ` +
      `effective=${getEffectiveProviderMode()}, cloudReady=${hasCloudFallback()}`,
  );
}

applyConfigToProvider();

export function reconfigureAI(cfg: {
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string;
  providerMode?: ProviderMode;
}) {
  if (cfg.baseUrl !== undefined) runtimeConfig.baseUrl = cfg.baseUrl || null;
  if (cfg.model !== undefined) runtimeConfig.model = cfg.model;
  if (cfg.apiKey !== undefined) runtimeConfig.apiKey = cfg.apiKey || null;
  if (cfg.providerMode !== undefined) runtimeConfig.providerMode = cfg.providerMode;
  applyConfigToProvider();
  // Keep the fullstack generator in sync with every reconfigure (called from
  // /ai/config, /slm/initialize, /slm/endpoint). Fire-and-forget so a missing
  // module never blocks the request.
  void (async () => {
    try {
      const { reconfigureGenerator } = await import("../src/modules/ai-fullstack-generator");
      if (typeof reconfigureGenerator === "function") {
        reconfigureGenerator({
          apiKey: runtimeConfig.apiKey || undefined,
          baseUrl: runtimeConfig.baseUrl || undefined,
          model: runtimeConfig.model,
        });
      }
    } catch {
      // generator module optional — ignore
    }
  })();
}

function buildConnectionResponse() {
  const realKey = !!runtimeConfig.apiKey && !isPlaceholderKey(runtimeConfig.apiKey);
  return {
    baseUrl: runtimeConfig.baseUrl,
    model: runtimeConfig.model,
    hasApiKey: realKey,
    clientReady: !!runtimeConfig.baseUrl && !!runtimeConfig.model,
    providerMode: runtimeConfig.providerMode,
    effectiveMode: getEffectiveProviderMode(),
    cloudReady: hasCloudFallback(),
  };
}

export function getRuntimeAIConfig() {
  const realKey = !!runtimeConfig.apiKey && !isPlaceholderKey(runtimeConfig.apiKey);
  return {
    baseUrl: runtimeConfig.baseUrl,
    model: runtimeConfig.model,
    providerMode: runtimeConfig.providerMode,
    effectiveMode: getEffectiveProviderMode(),
    hasRealKey: realKey,
    cloudReady: hasCloudFallback(),
    configured: !!runtimeConfig.baseUrl && !!runtimeConfig.model,
  };
}

const DEFAULT_PROMPT_CONFIG = {
  verbosity: "normal",
  style: "clean",
  includeComments: true,
  includeTests: false,
  strictTypeScript: true,
  preferFunctional: true,
  errorHandling: "graceful",
};

let promptConfig = { ...DEFAULT_PROMPT_CONFIG };

const PROMPT_PRESETS: Record<string, Partial<typeof DEFAULT_PROMPT_CONFIG>> = {
  minimal: { verbosity: "minimal", includeComments: false, includeTests: false },
  standard: { verbosity: "normal", includeComments: true, includeTests: false },
  detailed: { verbosity: "detailed", includeComments: true, includeTests: true },
  production: { verbosity: "normal", includeComments: true, includeTests: true, strictTypeScript: true, errorHandling: "graceful" },
};

router.get("/ai/connection", (_req, res) => {
  res.json(buildConnectionResponse());
});

router.post("/ai/config", (req, res) => {
  try {
    const { baseUrl, apiKey, model, providerMode } = req.body || {};
    const mode: ProviderMode | undefined =
      providerMode === "auto" || providerMode === "cloud" || providerMode === "local"
        ? providerMode
        : undefined;
    reconfigureAI({ baseUrl, apiKey, model, providerMode: mode });
    res.json({ success: true, config: buildConnectionResponse() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/ai/test", async (_req, res) => {
  const realKey = !!runtimeConfig.apiKey && !isPlaceholderKey(runtimeConfig.apiKey);
  const effective = getEffectiveProviderMode();

  if (effective === "cloud" && !realKey) {
    res.json({
      success: false,
      error: "Cloud-only mode selected but no real API key is configured.",
    });
    return;
  }

  if (effective === "local") {
    try {
      const status = await getProviderStatus();
      if (status.primary.available) {
        res.json({ success: true, provider: "local", model: status.primary.model });
      } else {
        res.json({
          success: false,
          error: "Local provider unavailable. Is Ollama running with the configured model?",
        });
      }
      return;
    } catch (e: any) {
      res.json({ success: false, error: `Local provider error: ${e?.message || e}` });
      return;
    }
  }

  if (!realKey && !runtimeConfig.baseUrl) {
    res.json({
      success: false,
      error: "No API key configured. Set an endpoint and API key in Settings first.",
    });
    return;
  }

  try {
    const { generateWithProvider } = await import("../src/modules/gemma-provider");
    const result = await generateWithProvider(
      "Reply with the single word: pong",
      "",
      { maxTokens: 8, temperature: 0 },
    );
    const text = (result?.content || "").trim();
    if (text) {
      res.json({ success: true, provider: result.source, model: result.model, sample: text });
    } else {
      res.json({ success: false, error: "Provider returned an empty response." });
    }
  } catch (e: any) {
    res.json({ success: false, error: `Provider error: ${e?.message || e}` });
  }
});

router.get("/ai/prompt-config", (_req, res) => {
  const summary = Object.entries(promptConfig)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  const preview = `// Style: ${promptConfig.style}, Verbosity: ${promptConfig.verbosity}`;
  res.json({
    success: true,
    config: promptConfig,
    summary,
    preview,
    presets: PROMPT_PRESETS,
  });
});

router.post("/ai/prompt-config", (req, res) => {
  try {
    const incoming = req.body || {};
    promptConfig = { ...promptConfig, ...incoming };
    const summary = Object.entries(promptConfig)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    const preview = `// Style: ${promptConfig.style}, Verbosity: ${promptConfig.verbosity}`;
    res.json({ success: true, config: promptConfig, summary, preview });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/ai/prompt-config/preset", (req, res) => {
  try {
    const { preset } = req.body || {};
    if (!preset || !PROMPT_PRESETS[preset]) {
      res.status(400).json({ error: `Unknown preset. Available: ${Object.keys(PROMPT_PRESETS).join(", ")}` });
      return;
    }
    promptConfig = { ...DEFAULT_PROMPT_CONFIG, ...PROMPT_PRESETS[preset] };
    const summary = Object.entries(promptConfig).map(([k, v]) => `${k}: ${v}`).join(", ");
    const preview = `// Style: ${promptConfig.style}, Verbosity: ${promptConfig.verbosity}`;
    res.json({ success: true, config: promptConfig, summary, preview });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/ai/prompt-config/preview", (_req, res) => {
  const preview = `// AutoCoder prompt config\n// Style: ${promptConfig.style}\n// Verbosity: ${promptConfig.verbosity}\n// Comments: ${promptConfig.includeComments}\n// Tests: ${promptConfig.includeTests}`;
  res.json({ success: true, preview, charCount: preview.length, lineCount: preview.split("\n").length });
});

router.get("/ai/status", async (_req, res) => {
  try {
    const providerStatus = await getProviderStatus();
    const gemmaHealth = providerStatus.primary.gemmaHealth;
    const pullInfo = gemmaHealth.pullCommand ? suggestPullGemma() : null;
    const effective = getEffectiveProviderMode();

    res.json({
      primaryModel: {
        name: "Gemma",
        model: providerStatus.primary.model,
        available: providerStatus.primary.available,
        ollamaRunning: gemmaHealth.ollamaAvailable,
        gemmaInstalled: gemmaHealth.gemmaInstalled,
        availableModels: gemmaHealth.availableModels,
      },
      fallback: {
        name: "Cloud AI",
        model: providerStatus.fallback.model,
        available: providerStatus.fallback.available,
      },
      providerMode: getProviderMode(),
      effectiveMode: effective,
      status: providerStatus.primary.available
        ? "ready"
        : providerStatus.fallback.available
          ? "fallback"
          : "offline",
      message: providerStatus.primary.available
        ? `Gemma (${providerStatus.primary.model}) ready — FREE local AI`
        : providerStatus.fallback.available
          ? `Using cloud (${providerStatus.fallback.model})`
          : "No AI available. Configure an API key or install Ollama.",
      pullInstructions: pullInfo,
    });
  } catch (error) {
    res.json({
      primaryModel: {
        name: "Gemma",
        model: "",
        available: false,
        ollamaRunning: false,
        gemmaInstalled: false,
        availableModels: [],
      },
      fallback: { name: "Cloud AI", model: "", available: false },
      providerMode: getProviderMode(),
      effectiveMode: getEffectiveProviderMode(),
      status: "error",
      message: "Failed to check AI status",
      pullInstructions: null,
    });
  }
});

void getDefaultGemmaModel;

export default router;
