/**
 * RuFlo Fusion — StageLedger + OWNERSHIP map + DriftEvent
 *
 * The security camera. Every read/write to ExecutiveMemory must go through
 * the ledger. Writes outside an agent's OWNERSHIP entry throw DriftEvent
 * (a hard stop) — there are no exceptions.
 */

import { ExecutiveMemory } from './executive-memory.js';
import type { AgentName, DecisionLog } from './types.js';

/**
 * THE LAW.
 * Frozen at module load. Each agent may only write fields listed here.
 */
export const OWNERSHIP: Readonly<Record<AgentName, readonly string[]>> = Object.freeze({
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
}) as Readonly<Record<AgentName, readonly string[]>>;

export class DriftEvent extends Error {
  override name = 'DriftEvent';
  constructor(public agent: AgentName, public field: string) {
    super(
      `DriftEvent: Agent "${agent}" attempted to write field "${field}" — ` +
        `not in OWNERSHIP map. Generation halted.`,
    );
  }
}

export interface LedgerEntry {
  agent: AgentName;
  field: string;
  op: 'read' | 'write';
  timestamp: number;
}

export class StageLedger {
  private log: LedgerEntry[] = [];

  constructor(private memory: ExecutiveMemory) {}

  /**
   * Write a value to a memory field. Throws DriftEvent if the agent does not
   * own the field. On success, appends to the audit trail and applies the
   * value to memory.
   */
  write(agent: AgentName, field: string, value: unknown, rationale?: string): void {
    const allowed = OWNERSHIP[agent];
    if (!allowed?.includes(field)) {
      throw new DriftEvent(agent, field);
    }
    const ts = Date.now();
    this.log.push({ agent, field, op: 'write', timestamp: ts });
    const decision: DecisionLog = { agent, field, value, timestamp: ts, rationale };
    this.memory.decisions.push(decision);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.memory as any)[field] = value;
  }

  /** Read a memory field; recorded for the audit trail. */
  read(agent: AgentName, field: string): unknown {
    this.log.push({ agent, field, op: 'read', timestamp: Date.now() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.memory as any)[field];
  }

  /** Return an immutable copy of the full ledger. */
  getFullLog(): LedgerEntry[] {
    return [...this.log];
  }

  /** Convenience: total writes by a specific agent. */
  writeCount(agent: AgentName): number {
    return this.log.filter((e) => e.agent === agent && e.op === 'write').length;
  }
}
