/**
 * RuFlo Fusion — Agent runner
 *
 * Wraps every agent execution in:
 *   1. Per-agent timeout guard (Promise.race vs HaltEvent)
 *   2. Output schema validation
 *   3. StageLedger.write() into the owned field
 *
 * Execution logic itself is dispatched per agent via executeAgentLogic().
 */

import { ExecutiveMemory } from './executive-memory.js';
import { logEvent } from './observability-sink.js';
import { StageLedger } from './stage-ledger.js';
import type { AgentName } from './types.js';

import { runQueen } from './agents/queen.js';
import { runPlanner } from './agents/planner.js';
import { runArchitect } from './agents/architect.js';
import { runSystem } from './agents/system.js';
import { runDesigner } from './agents/designer.js';
import { runCoder } from './agents/coder.js';
import { runDebugger } from './agents/debugger.js';
import { runSecurity } from './agents/security.js';
import { runReviewer } from './agents/reviewer.js';
import { runTester } from './agents/tester.js';

/** Per-agent execution budget in milliseconds. */
export const TIMEOUTS: Readonly<Record<AgentName, number>> = Object.freeze({
  Queen: 5000,
  Planner: 8000,
  Architect: 8000,
  System: 8000,
  Designer: 8000,
  Coder: 30000,
  Debugger: 8000,
  Reviewer: 5000,
  Tester: 8000,
  Security: 5000,
});

/** Memory field this agent is allowed to write. */
export const OWNED_FIELD: Readonly<Record<AgentName, string>> = Object.freeze({
  Queen: 'taskSpec',
  Planner: 'planner',
  Architect: 'architect',
  System: 'system',
  Designer: 'designer',
  Coder: 'coder',
  Debugger: 'debugger',
  Security: 'security',
  Reviewer: 'reviewer',
  Tester: 'tester',
});

export class SkipEvent extends Error {
  override name = 'SkipEvent';
  constructor(public agent: AgentName, public reason: string) {
    super(`SkipEvent: ${agent} bypassed — ${reason}`);
  }
}

export class HaltEvent extends Error {
  override name = 'HaltEvent';
  constructor(public agent: AgentName, public limitMs: number) {
    super(`HaltEvent: ${agent} timed out after ${limitMs}ms`);
  }
}

export interface AgentRunContext {
  prompt: string;
  /**
   * Optional original PipelineContext passed through from
   * pipeline-orchestrator, so agents that wrap existing modules can re-use
   * downstream signals (plan, understanding, files, etc.).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  legacyCtx?: any;
}

/** Best-effort SLM reachability probe. Never throws. */
export async function checkHealth(_agent: AgentName): Promise<void> {
  // SLM availability is non-fatal — every agent has a rules-only fallback.
  // We just record the state in the observability sink.
  try {
    // dynamic import keeps this module loadable even if the SLM module fails
    const mod = await import('../slm-inference-engine.js');
    if (typeof mod.isSLMAvailable === 'function' && !mod.isSLMAvailable()) {
      logEvent({ type: 'slm_unavailable', agent: _agent, fallback: 'rules-only' });
    }
  } catch {
    logEvent({ type: 'slm_unavailable', agent: _agent, fallback: 'rules-only' });
  }
}

export async function runAgent(
  agent: AgentName,
  ledger: StageLedger,
  mem: ExecutiveMemory,
  runCtx: AgentRunContext,
): Promise<void> {
  const limitMs = TIMEOUTS[agent];
  logEvent({ type: 'agent_start', agent, timestamp: Date.now() });
  const startMs = Date.now();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HaltEvent(agent, limitMs)), limitMs);
  });

  try {
    const result = await Promise.race([
      executeAgentLogic(agent, ledger, mem, runCtx),
      timeoutPromise,
    ]);
    validateOutputShape(agent, result);
    ledger.write(agent, OWNED_FIELD[agent], result);
    logEvent({ type: 'agent_complete', agent, durationMs: Date.now() - startMs });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function executeAgentLogic(
  agent: AgentName,
  ledger: StageLedger,
  mem: ExecutiveMemory,
  runCtx: AgentRunContext,
): Promise<unknown> {
  switch (agent) {
    case 'Queen':
      return runQueen(runCtx.prompt, runCtx.legacyCtx);
    case 'Planner':
      return runPlanner(mem, ledger, runCtx);
    case 'Architect':
      return runArchitect(mem, ledger, runCtx);
    case 'System':
      return runSystem(mem, ledger, runCtx);
    case 'Designer':
      return runDesigner(mem, ledger, runCtx);
    case 'Coder':
      return runCoder(mem, ledger, runCtx);
    case 'Debugger':
      return runDebugger(mem, ledger, runCtx);
    case 'Security':
      return runSecurity(mem, ledger, runCtx);
    case 'Reviewer':
      return runReviewer(mem, ledger, runCtx);
    case 'Tester':
      return runTester(mem, ledger, runCtx);
    default: {
      const _exhaustive: never = agent;
      throw new Error(`Unknown agent: ${String(_exhaustive)}`);
    }
  }
}

/** Lightweight runtime shape check. Throws on schema mismatch. */
function validateOutputShape(agent: AgentName, result: unknown): void {
  if (result == null || typeof result !== 'object') {
    throw new Error(`Agent "${agent}" returned non-object output`);
  }
  const r = result as Record<string, unknown>;
  switch (agent) {
    case 'Queen':
      if (typeof r.domain !== 'string' || !Array.isArray(r.mustHaveFeatures)) {
        throw new Error(`Queen output missing required fields (domain, mustHaveFeatures)`);
      }
      break;
    case 'Planner':
      if (!Array.isArray(r.features)) throw new Error(`Planner output missing features[]`);
      break;
    case 'Architect':
      if (!r.architecture || !Array.isArray(r.fileGraph)) {
        throw new Error(`Architect output missing architecture/fileGraph`);
      }
      break;
    case 'System':
      if (!r.logic || !Array.isArray(r.apiRoutes)) {
        throw new Error(`System output missing logic/apiRoutes`);
      }
      break;
    case 'Designer':
      if (!Array.isArray(r.components)) throw new Error(`Designer output missing components[]`);
      break;
    case 'Coder':
      if (!r.sourceFiles || typeof r.sourceFiles !== 'object') {
        throw new Error(`Coder output missing sourceFiles{}`);
      }
      break;
    case 'Debugger':
      if (!Array.isArray(r.repairDiffs)) throw new Error(`Debugger output missing repairDiffs[]`);
      break;
    case 'Security':
      if (!r.securityReport) throw new Error(`Security output missing securityReport`);
      break;
    case 'Reviewer':
      if (typeof r.qualityScore !== 'number' || !Array.isArray(r.annotations)) {
        throw new Error(`Reviewer output missing qualityScore/annotations`);
      }
      break;
    case 'Tester':
      if (!r.testFiles || typeof r.testFiles !== 'object') {
        throw new Error(`Tester output missing testFiles{}`);
      }
      break;
  }
}
