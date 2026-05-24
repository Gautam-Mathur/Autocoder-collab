import { describe, it, expect, vi } from 'vitest';
import { ExecutiveMemory } from '@workspace/core/ExecutiveMemory';
import { StageLedger, DriftEvent, OWNERSHIP } from '@workspace/core/StageLedger';

describe('RuFlo Foundation (ExecutiveMemory & StageLedger)', () => {
  it('should enforce ownership bounds on write operations', () => {
    const mem = new ExecutiveMemory();
    const ledger = new StageLedger(mem);

    // Planner owns 'planner' field
    expect(() => {
      ledger.write('Planner', 'planner', { features: [], requirements: [], todo: [] });
    }).not.toThrow();

    expect(mem.planner).not.toBeNull();

    // Planner does NOT own 'architect' field
    expect(() => {
      ledger.write('Planner', 'architect', { architecture: { modules: [], techStack: [] }, fileGraph: [] });
    }).toThrow(DriftEvent);
  });

  it('should capture rationale and value in DriftEvent', () => {
    const mem = new ExecutiveMemory();
    const ledger = new StageLedger(mem);

    try {
      ledger.write('Coder', 'architect', { mockArchitect: true }, 'Need updated modules');
      throw new Error('Should have thrown DriftEvent');
    } catch (err) {
      expect(err).toBeInstanceOf(DriftEvent);
      const drift = err as DriftEvent;
      expect(drift.agent).toBe('Coder');
      expect(drift.field).toBe('architect');
      expect(drift.value).toEqual({ mockArchitect: true });
      expect(drift.rationale).toBe('Need updated modules');
    }
  });

  it('should support reading allowed fields', () => {
    const mem = new ExecutiveMemory();
    const ledger = new StageLedger(mem);

    // Initial state
    expect(ledger.read('Coder', 'architect')).toBeNull();

    // Let Architect write and Coder read
    ledger.write('Architect', 'architect', { architecture: { modules: [], techStack: ['react'] }, fileGraph: [] });
    const arch = ledger.read('Coder', 'architect');
    expect(arch).toEqual({ architecture: { modules: [], techStack: ['react'] }, fileGraph: [] });
  });
});

describe('DriftNegotiation Loop Simulation', () => {
  it('should trigger negotiation, rewind, and successfully complete', async () => {
    const mem = new ExecutiveMemory();
    const ledger = new StageLedger(mem);

    // Simulate a simple 2-agent pipeline: Architect -> Coder
    const pipeline = ['Architect', 'Coder'];
    let archRuns = 0;
    let coderRuns = 0;

    // Spec setup
    ledger.write('Queen', 'taskSpec', {
      domain: 'vapt',
      userType: 'admin',
      coreFlow: 'scan',
      mustHaveFeatures: [],
      explicitNonGoals: [],
    });

    const runAgent = async (agent: string) => {
      if (agent === 'Architect') {
        archRuns++;
        // Check for pending requests
        const pending = mem.amendmentRequests.find(r => r.field === 'architect' && r.status === 'pending');
        if (pending) {
          pending.status = 'approved';
          const requested = pending.value as any;
          ledger.write('Architect', 'architect', {
            architecture: { modules: requested.modules, techStack: ['react'] },
            fileGraph: [{ file: 'extra-file.tsx', exports: [], imports: [] }],
          });
          return;
        }

        // Base generation
        ledger.write('Architect', 'architect', {
          architecture: { modules: [], techStack: ['react'] },
          fileGraph: [],
        });
      } else if (agent === 'Coder') {
        coderRuns++;
        const arch = ledger.read('Coder', 'architect') as any;

        // Coder decides it needs a new file not present in Architect's graph
        if (!arch.fileGraph.some((f: any) => f.file === 'extra-file.tsx')) {
          // Attempt to modify Architect's field to request amendment
          ledger.write('Coder', 'architect', {
            modules: [{ name: 'ExtraModule', type: 'component' }],
          }, 'Coder needs ExtraModule to implement frontend components');
        }

        ledger.write('Coder', 'coder', {
          sourceFiles: { 'src/main.tsx': '// code' },
        });
      }
    };

    // Pipeline runner
    for (let i = 0; i < pipeline.length; i++) {
      const agent = pipeline[i];
      try {
        await runAgent(agent);
      } catch (err) {
        if (err instanceof DriftEvent) {
          const owner = 'Architect'; // Mock ownership look up
          mem.amendmentRequests.push({
            requestor: err.agent,
            field: err.field,
            value: err.value,
            rationale: err.rationale,
            timestamp: Date.now(),
            status: 'pending',
          });

          // Invalidate and rewind
          const ownerIndex = pipeline.indexOf(owner);
          i = ownerIndex - 1; // loop increment makes it ownerIndex
          continue;
        }
        throw err;
      }
    }

    // Verify Architect ran twice (first time base, second time negotiate/approve)
    expect(archRuns).toBe(2);
    // Verify Coder ran twice (first time drift/halt, second time successful completion)
    expect(coderRuns).toBe(2);

    // Verify final memory state contains the approved amendment details
    const finalArch = mem.architect;
    expect(finalArch?.fileGraph).toContainEqual({ file: 'extra-file.tsx', exports: [], imports: [] });
    expect(finalArch?.architecture.modules).toContainEqual({ name: 'ExtraModule', type: 'component' });
    expect(mem.coder).not.toBeNull();
    expect(mem.amendmentRequests[0].status).toBe('approved');
  });
});

describe('RuFlo Phase 5 (Hardening & Observability)', () => {
  it('should truncate knowledge injection context at 500-token cap', async () => {
    const { summarizeToTokenCap } = await import('../src/modules/ruflo/knowledge-injector.js');
    const longText = 'a'.repeat(3000); // 3000 chars > 2000 chars (500 tokens)
    const result = summarizeToTokenCap(longText, 500);
    expect(result.length).toBeLessThanOrEqual(2000 + 40); // 2000 chars cap + truncation message length
    expect(result).toContain('[KB truncated at 500-token cap]');
  });

  it('should register and dispatch to telemetry sinks', async () => {
    const { emitDecision, emitDriftEvent, getRegisteredSinks, _resetSinksForTests } = await import('../src/modules/telemetry/sinks.js');
    
    // Test helper to verify telemetry emitter works
    const sinksInfo = getRegisteredSinks();
    expect(sinksInfo.some(s => s.name === 'console')).toBe(true);

    // Try emitting decision and drift event (should not throw)
    expect(() => {
      emitDecision('Coder', 'architect', { feature: 'extra' }, 'Need module', 'conv-123');
      emitDriftEvent('Coder', 'architect', { feature: 'extra' }, 'Need module', 'conv-123');
    }).not.toThrow();
  });
});

describe('RuFlo Phase 6 (Ship Gate Final Delivery)', () => {
  it('should run shipGate and invoke 3-layer cascade on relative import failure', async () => {
    const { shipGate } = await import('../src/modules/ruflo/ship-gate.js');
    
    // Input files: main.tsx contains an unresolved import relative to it
    const sourceFiles = {
      'src/main.tsx': "import { nonExistent } from './non-existent';\n",
    };

    const report = await shipGate({
      sourceFiles,
      testFiles: {},
      qualityScore: 90,
      securityIssues: [],
      agentTimings: {},
      decisions: [],
      events: [],
      errors: [],
    });

    // The unresolved import should trigger the cascade. Since SLM is not running, it falls through to template fallback (Layer 3).
    expect(report.fallbacksTriggered).toBe(1);
    expect(report.repairAttemptsUsed).toBe(1);
    expect(report.sourceFiles['src/main.tsx']).toContain('main (fallback)');
  });
});


