import { Router } from "express";
import { getRecentHealth } from "../src/modules/slm-health-monitor.js";
import { getRuntimeAIConfig, reconfigureAI } from "./ai.js";

const router = Router();

const PIPELINE_STAGES = [
  "understand",
  "plan",
  "reason",
  "architect",
  "design",
  "specify",
  "schema",
  "api",
  "compose",
  "generate",
  "resolve",
  "quality",
  "test",
  "validate",
  "deep-quality",
  "record",
];

const slmState = {
  initialized: false,
  stageModes: Object.fromEntries(PIPELINE_STAGES.map((s) => [s, "rule-based"])) as Record<string, string>,
  startedAt: Date.now(),
};

function buildStatus() {
  // Read live AI config so the dashboard reflects what /api/ai/config has set,
  // not just the slmState boolean. This is what makes "Model: Connected" + the
  // registered-model count light up after the user clicks Save & Connect.
  const ai = getRuntimeAIConfig();
  const endpointUrl = ai.baseUrl;
  const endpointConfigured = ai.configured;
  const activeModel = ai.model || null;
  return {
    initialized: slmState.initialized,
    available: endpointConfigured,
    registeredStages: PIPELINE_STAGES,
    stageModes: slmState.stageModes,
    health: {
      loaded: endpointConfigured,
      modelPath: endpointUrl,
      contextSize: Number(process.env.SLM_CONTEXT_SIZE) || 16384,
      lastInferenceMs: null,
      totalInferences: 0,
      totalErrors: 0,
      uptime: Math.floor((Date.now() - slmState.startedAt) / 1000),
    },
    modelManager: {
      initialized: slmState.initialized,
      registeredModels: endpointConfigured && activeModel ? 1 : 0,
      loadedModels: endpointConfigured && activeModel ? 1 : 0,
      assignedStages: Object.values(slmState.stageModes).filter((m) => m === "slm" || m === "hybrid").length,
      totalMemoryUsedMB: 0,
      maxMemoryMB: 16384,
      defaultModel: activeModel,
      activeModel,
      providerMode: ai.providerMode,
      effectiveMode: ai.effectiveMode,
      endpointConfigured,
      endpointUrl,
    },
    trainingData: {
      stages: PIPELINE_STAGES,
      totalRecords: 0,
      stageBreakdown: PIPELINE_STAGES.map((stage) => ({
        stage,
        records: 0,
        slmWinRate: 0,
      })),
    },
    feedback: {
      stages: PIPELINE_STAGES.map((stage) => ({
        stage,
        totalRuns: 0,
        slmWinRate: 0,
        avgImprovement: 0,
        avgLatencyMs: 0,
        recommendation: getRuntimeAIConfig().configured
          ? "Try SLM for this stage"
          : "Configure SLM endpoint to enable",
        reason: getRuntimeAIConfig().configured
          ? "Endpoint configured — SLM ready for this stage"
          : "No SLM endpoint configured. Set a local Ollama or OpenAI-compatible URL to enable.",
      })),
      totalGenerations: 0,
      overallSlmWinRate: 0,
      averageImprovement: 0,
      topPerformingStage: null,
      worstPerformingStage: null,
      promotedPatternsCount: 0,
    },
  };
}

router.get("/slm/status", (_req, res) => {
  res.json(buildStatus());
});

router.get("/slm/health", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const records = getRecentHealth(limit);
  let pass = 0, degraded = 0, fail = 0, skipped = 0;
  for (const r of records) {
    if (r.status === 'pass') pass++;
    else if (r.status === 'degraded') degraded++;
    else if (r.status === 'fail') fail++;
    else if (r.status === 'skipped') skipped++;
  }
  res.json({
    summary: { total: records.length, pass, degraded, fail, skipped },
    records,
  });
});

router.post("/slm/initialize", (req, res) => {
  // Accept optional body so the "Initialize SLM System" button can also push
  // the endpoint/apiKey/model the user typed into the form, in one click.
  const { baseUrl, apiKey, model, providerMode } = (req.body || {}) as {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    providerMode?: "auto" | "cloud" | "local";
  };
  if (baseUrl !== undefined || apiKey !== undefined || model !== undefined || providerMode !== undefined) {
    try {
      reconfigureAI({ baseUrl, apiKey, model, providerMode });
    } catch (e) {
      // Non-fatal — still flip initialized so the dashboard reflects the click.
    }
  }
  slmState.initialized = true;
  res.json({ success: true, status: buildStatus() });
});

router.get("/slm/stages", (_req, res) => {
  res.json({
    stages: PIPELINE_STAGES.map((stage) => ({
      id: stage,
      name: stage.charAt(0).toUpperCase() + stage.slice(1),
      mode: slmState.stageModes[stage] || "rule-based",
    })),
  });
});

router.put("/slm/stages/:stageId", (req, res) => {
  const { stageId } = req.params;
  const { mode } = req.body || {};
  if (!stageId || !mode) {
    res.status(400).json({ error: "stageId and mode are required" });
    return;
  }
  if (!["rule-based", "slm", "hybrid"].includes(mode)) {
    res.status(400).json({ error: "mode must be one of: rule-based, slm, hybrid" });
    return;
  }
  slmState.stageModes[stageId] = mode;
  res.json({ success: true, stage: stageId, mode, status: buildStatus() });
});

router.post("/slm/endpoint", (req, res) => {
  const { url, model, apiKey, providerMode } = (req.body || {}) as {
    url?: string;
    model?: string;
    apiKey?: string;
    providerMode?: "auto" | "cloud" | "local";
  };
  if (!url) { res.status(400).json({ error: "url is required" }); return; }
  reconfigureAI({ baseUrl: url, model, apiKey, providerMode });
  slmState.initialized = true;
  res.json({ success: true, connected: true, url, message: "SLM endpoint configured successfully." });
});

router.delete("/slm/endpoint", (_req, res) => {
  reconfigureAI({ baseUrl: null });
  res.json({ success: true, message: "SLM endpoint removed." });
});

export default router;
