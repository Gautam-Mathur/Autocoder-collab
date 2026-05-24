import { AgentStage, ExecutiveMemory } from './ExecutiveMemory.js';

export class DriftEvent extends Error {
  constructor(public agent: AgentStage, public field: string) {
    super(`DriftEvent: Agent ${agent} attempted to write outside its scope (field: ${field}).`);
    this.name = 'DriftEvent';
  }
}

export class AmendmentRequest extends Error {
  constructor(public requestingAgent: AgentStage, public targetAgent: AgentStage, public reason: string) {
    super(`AmendmentRequest: ${requestingAgent} requesting ${targetAgent} to amend scope due to: ${reason}`);
    this.name = 'AmendmentRequest';
  }
}

export const OWNERSHIP_MAP: Record<string, AgentStage> = {
  'intent': 'Queen',
  'features': 'Planner',
  'fileGraph': 'Architect',
  'dataModels': 'System',
  'uiComponents': 'Designer',
  'sourceFiles': 'Coder'
};

export class StageLedger {
  constructor(private memory: ExecutiveMemory) {}

  write(agent: AgentStage, field: string, data: any) {
    const owner = OWNERSHIP_MAP[field];
    if (owner && owner !== agent) {
      // Trigger DriftNegotiation loop instead of hard crash
      throw new AmendmentRequest(agent, owner, `Requires modification to ${field}`);
    }
    this.memory.setOutput(agent, { ...this.memory.getOutput(agent), [field]: data });
    this.memory.recordDecision(agent, `Wrote to ${field}`);
  }
  
  read(agent: AgentStage, field: string) {
    this.memory.recordDecision(agent, `Read from ${field}`);
    const owner = OWNERSHIP_MAP[field];
    if (owner) {
      const ownerData = this.memory.getOutput(owner) || {};
      return ownerData[field];
    }
    return undefined;
  }
}
