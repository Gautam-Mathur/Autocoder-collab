/**
 * RuFlo Fusion — public barrel.
 *
 * Re-exports every entry point external code (pipeline-orchestrator,
 * routes/autocoder.ts, frontend) needs to consume the system.
 */

export * from './types.js';
export { ExecutiveMemory } from './executive-memory.js';
export { DriftEvent, OWNERSHIP, StageLedger, type LedgerEntry } from './stage-ledger.js';
export { DEPENDENCIES, propagateInvalidation, shouldRun } from './dependency-graph.js';
export {
  ContractViolationError,
  findResponsibleAgents,
  validateConsistency,
} from './contract-validator.js';
export { drainEvents, logEvent, setExternalEmitter, snapshotEvents } from './observability-sink.js';
export { KB_CHAR_CAP, KB_TOKEN_CAP, injectKnowledge, summarizeToTokenCap } from './knowledge-injector.js';
export {
  HaltEvent,
  OWNED_FIELD,
  SkipEvent,
  TIMEOUTS,
  checkHealth,
  runAgent,
  type AgentRunContext,
} from './agent-runner.js';
export { runRuFloPipeline, type RuFloRunOptions } from './sequential-controller.js';
export { MAX_PATCH_SIZE } from './agents/debugger.js';
export { shipGate, type ShipGateInput } from './ship-gate.js';
