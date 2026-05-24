/**
 * MCP tool registry — exposes AutoCoder pipeline capabilities to MCP clients.
 *
 * Tools:
 *   - `list_stacks`              enumerate supported output stacks
 *   - `list_pipeline_stages`     show the 17-stage pipeline
 *   - `get_complexity_profile`   classify a request without running anything
 *   - `dry_run_plan`             generate the project plan only (Initiative F)
 *   - `generate_app`             run the full pipeline and return files
 *   - `get_slm_health`           recent SLM health records
 *   - `get_telemetry_sinks`      list active observability sinks
 *
 * NOTE: tools are pull-only — they don't stream progress over MCP. Long
 * generations should use `dry_run_plan` first to inspect the plan, then
 * `generate_app` once approved.
 */

import type { McpToolHandler } from './types.js';
import { classifyComplexity } from '../src/modules/complexity-classifier.js';
import { analyzeRequest } from '../src/modules/deep-understanding-engine.js';
import { orchestratePlanning, orchestrateGeneration, getPipelineStages } from '../src/modules/pipeline-orchestrator.js';
import { getRecentHealth } from '../src/modules/slm-health-monitor.js';
import { getRegisteredSinks } from '../src/modules/telemetry/sinks.js';

const SUPPORTED_STACKS = [
  { id: 'react-vite-express', name: 'React + Vite + Express', description: 'Default fullstack JS/TS stack' },
  { id: 'mern', name: 'MERN', description: 'MongoDB + Express + React + Node' },
  { id: 'django', name: 'Django', description: 'Python web framework' },
  { id: 'spring-boot', name: 'Spring Boot', description: 'Java enterprise stack' },
  { id: 'dotnet', name: '.NET', description: 'ASP.NET Core' },
  { id: 'go-gin', name: 'Go + Gin', description: 'Go web framework' },
];

const tools = new Map<string, McpToolHandler>();

function register(handler: McpToolHandler) {
  tools.set(handler.def.name, handler);
}

register({
  def: {
    name: 'list_stacks',
    description: 'List the supported output stacks for code generation.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  call: () => ({ stacks: SUPPORTED_STACKS }),
});

register({
  def: {
    name: 'list_pipeline_stages',
    description: 'List the 17 stages of the AutoCoder generation pipeline.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  call: () => ({ stages: getPipelineStages() }),
});

register({
  def: {
    name: 'get_complexity_profile',
    description:
      'Classify a request into a complexity tier (minimal/small/medium/large/xl) without running the pipeline. Returns the active stage gating + file budget.',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'Plain-English app description' },
      },
      required: ['request'],
    },
  },
  call: (args) => {
    const request = String(args.request || '');
    if (!request.trim()) throw new Error('request is required');
    const profile = classifyComplexity(request);
    return { profile };
  },
});

register({
  def: {
    name: 'dry_run_plan',
    description:
      'Run only the understanding + planning stages (Initiative F: dry-run). Returns the project plan without generating any code.',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'Plain-English app description' },
      },
      required: ['request'],
    },
  },
  call: (args) => {
    const request = String(args.request || '');
    if (!request.trim()) throw new Error('request is required');
    const understanding = analyzeRequest(request);
    const { plan, thinkingSteps } = orchestratePlanning(understanding);
    return {
      plan,
      thinkingStepCount: thinkingSteps.length,
      summary: {
        projectName: plan.projectName,
        entities: plan.dataModel?.length || 0,
        pages: plan.pages?.length || 0,
        endpoints: plan.apiEndpoints?.length || 0,
      },
    };
  },
});

register({
  def: {
    name: 'generate_app',
    description:
      'Run the full pipeline. Generates a complete project from a plain-English description. Returns the file list and validation summary. Long-running.',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'Plain-English app description' },
        plan: {
          type: 'object',
          description: 'Optional pre-built ProjectPlan from `dry_run_plan` to skip planning',
        },
      },
      required: ['request'],
    },
  },
  call: async (args) => {
    const request = String(args.request || '');
    if (!request.trim()) throw new Error('request is required');
    if (request.length > 8000) throw new Error('request too long (max 8000 chars)');
    // Security: serialize generations triggered via MCP. The full pipeline is
    // expensive; allowing concurrent runs from an unauthenticated MCP client
    // would exhaust LLM quotas / memory.
    if ((globalThis as any).__autocoder_mcp_busy) {
      throw new Error('a generation is already in progress; try again when it completes');
    }
    (globalThis as any).__autocoder_mcp_busy = true;
    const understanding = analyzeRequest(request);
    let plan = (args.plan as any) || null;
    if (plan != null && (typeof plan !== 'object' || Array.isArray(plan))) {
      (globalThis as any).__autocoder_mcp_busy = false;
      throw new Error('plan must be an object');
    }
    if (!plan) {
      const planning = orchestratePlanning(understanding);
      plan = planning.plan;
    }
    let result;
    try {
      result = await orchestrateGeneration(plan, understanding);
    } finally {
      (globalThis as any).__autocoder_mcp_busy = false;
    }
    return {
      success: result.success,
      fileCount: result.files.length,
      files: result.files.map((f) => ({ path: f.path, language: f.language, bytes: f.content.length })),
      summary: result.summary,
      slmHealth: result.slmHealth,
      complexityProfile: result.complexityProfile,
      generationMode: result.generationMode,
      semanticValidation: result.semanticValidation
        ? { ok: result.semanticValidation.blocking.length === 0 }
        : undefined,
    };
  },
});

register({
  def: {
    name: 'get_slm_health',
    description: 'Return the most recent SLM health records (cross-conversation rolling window).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max records (default 50)' },
      },
      required: [],
    },
  },
  call: (args) => ({ records: getRecentHealth(Number(args.limit) || 50) }),
});

register({
  def: {
    name: 'get_telemetry_sinks',
    description: 'List active observability sinks (Initiative C).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  call: () => ({ sinks: getRegisteredSinks() }),
});

export function getAllTools(): Map<string, McpToolHandler> {
  return tools;
}
