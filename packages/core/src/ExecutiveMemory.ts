export type AgentStage =
  | 'Queen'
  | 'Planner'
  | 'Architect'
  | 'System'
  | 'Designer'
  | 'Coder'
  | 'Debugger'
  | 'Reviewer'
  | 'Tester';

export interface ExecutiveMemoryDecision {
  agent: AgentStage;
  field: string;
  value: unknown;
  timestamp: number;
  rationale?: string;
}

export class ExecutiveMemory {
  taskSpec: unknown | null = null;
  planner: unknown | null = null;
  architect: unknown | null = null;
  system: unknown | null = null;
  designer: unknown | null = null;
  coder: unknown | null = null;
  debugger: unknown | null = null;
  security: unknown | null = null;
  reviewer: unknown | null = null;
  tester: unknown | null = null;

  decisions: ExecutiveMemoryDecision[] = [];
  invalidated: Set<AgentStage> = new Set();

  clearInvalidated(): void {
    this.invalidated.clear();
  }
}

export default ExecutiveMemory;
