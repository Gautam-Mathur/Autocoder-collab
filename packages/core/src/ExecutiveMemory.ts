export type AgentStage = 'Queen' | 'Planner' | 'Architect' | 'System' | 'Designer' | 'Coder' | 'Debugger' | 'Reviewer' | 'Tester';

export interface DecisionLogEntry {
  stage: AgentStage;
  timestamp: number;
  decision: string;
  context: any;
}

export class ExecutiveMemory {
  public structuredOutputs: Map<AgentStage, any> = new Map();
  public decisionLog: DecisionLogEntry[] = [];
  public invalidated: Set<AgentStage> = new Set();

  recordDecision(stage: AgentStage, decision: string, context?: any) {
    this.decisionLog.push({ stage, timestamp: Date.now(), decision, context });
  }

  getOutput<T>(stage: AgentStage): T | undefined {
    return this.structuredOutputs.get(stage);
  }

  setOutput(stage: AgentStage, output: any) {
    this.structuredOutputs.set(stage, output);
  }

  isInvalidated(stage: AgentStage): boolean {
    return this.invalidated.has(stage);
  }
}
