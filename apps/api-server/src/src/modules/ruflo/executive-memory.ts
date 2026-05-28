/**
 * RuFlo Fusion — ExecutiveMemory
 *
 * The shared whiteboard. All agents read and (selectively) write here through
 * StageLedger. Direct mutation is allowed only via the ledger to preserve the
 * audit trail and ownership enforcement.
 */

import type {
  AgentName,
  TaskSpec,
  PlannerOutput,
  ArchitectOutput,
  SystemOutput,
  DesignerOutput,
  CoderOutput,
  DebuggerOutput,
  SecurityOutput,
  ReviewerOutput,
  TesterOutput,
  RefinerOutput,
  DecisionLog,
} from './types.js';

export class ExecutiveMemory {
  // Specification phase
  taskSpec: TaskSpec | null = null;
  planner: PlannerOutput | null = null;
  architect: ArchitectOutput | null = null;

  // Implementation phase
  system: SystemOutput | null = null;
  designer: DesignerOutput | null = null;
  coder: CoderOutput | null = null;

  // Verification phase
  debugger: DebuggerOutput | null = null;
  security: SecurityOutput | null = null;
  reviewer: ReviewerOutput | null = null;
  tester: TesterOutput | null = null;
  refiner: RefinerOutput | null = null;

  // Infrastructure
  decisions: DecisionLog[] = [];
  invalidated: Set<AgentName> = new Set();

  /** Reset the dirty set after a successful run. */
  clearInvalidated(): void {
    this.invalidated.clear();
  }
}
