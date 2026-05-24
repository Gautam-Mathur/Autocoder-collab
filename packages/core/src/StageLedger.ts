import { AgentStage, ExecutiveMemory, ExecutiveMemoryDecision } from './ExecutiveMemory.js';

export const OWNERSHIP: Readonly<Record<AgentStage, readonly string[]>> = Object.freeze({
  Queen:     Object.freeze(['taskSpec']),
  Planner:   Object.freeze(['planner']),
  Architect: Object.freeze(['architect']),
  System:    Object.freeze(['system']),
  Designer:  Object.freeze(['designer']),
  Coder:     Object.freeze(['coder']),
  Debugger:  Object.freeze(['debugger']),
  Security:  Object.freeze(['security']),
  Reviewer:  Object.freeze(['reviewer']),
  Tester:    Object.freeze(['tester']),
});

export class DriftEvent extends Error {
  override name = 'DriftEvent';
  constructor(
    public agent: AgentStage,
    public field: string,
    public value: unknown,
    public rationale?: string
  ) {
    super(
      `DriftEvent: Agent "${agent}" attempted to write field "${field}" — not in OWNERSHIP map. Generation halted.`,
    );
  }
}

export interface LedgerEntry {
  agent: AgentStage;
  field: string;
  op: 'read' | 'write';
  timestamp: number;
}

export class StageLedger {
  private log: LedgerEntry[] = [];

  constructor(private memory: ExecutiveMemory) {}

  write(agent: AgentStage, field: string, value: unknown, rationale?: string): void {
    const allowed = OWNERSHIP[agent];
    if (!allowed?.includes(field)) {
      throw new DriftEvent(agent, field, value, rationale);
    }
    const ts = Date.now();
    this.log.push({ agent, field, op: 'write', timestamp: ts });
    const decision: ExecutiveMemoryDecision = { agent, field, value, timestamp: ts, rationale };
    this.memory.decisions.push(decision);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.memory as any)[field] = value;
  }

  read(agent: AgentStage, field: string): unknown {
    this.log.push({ agent, field, op: 'read', timestamp: Date.now() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.memory as any)[field];
  }

  getFullLog(): LedgerEntry[] {
    return [...this.log];
  }

  writeCount(agent: AgentStage): number {
    return this.log.filter((e) => e.agent === agent && e.op === 'write').length;
  }
}

export default StageLedger;
