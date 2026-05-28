import { describe, it, expect, vi } from 'vitest';
import { runRuFloPipeline } from '../ruflo/sequential-controller.js';

vi.mock('../slm-inference-engine.js', () => ({
  runSLM: vi.fn().mockImplementation(async (stage) => {
    if (stage === 'Queen') {
      return {
        success: true,
        data: {
          domain: 'ecommerce',
          userType: 'customer',
          coreFlow: 'user browses items',
          mustHaveFeatures: ['browse', 'cart'],
          explicitNonGoals: [],
          agentTasks: {
            Planner: 'Plan features',
            Architect: 'Plan modules',
            System: 'Define routes',
            Designer: 'Create components',
            Coder: 'Write code',
            Tester: 'Write tests',
            Debugger: 'Fix bugs',
            Security: 'Audit security',
            Reviewer: 'Review quality',
            Refiner: 'Polish code'
          }
        }
      };
    }
    if (stage === 'Planner') {
      return {
        success: true,
        data: {
          features: [{ id: 'F001', name: 'Browse', acceptanceCriteria: ['criteria'], priority: 'must' }],
          requirements: [{ id: 'R001', description: 'desc', type: 'functional' }],
          todo: [{ id: 'T001', description: 'todo', done: false }]
        }
      };
    }
    if (stage === 'System') {
      return {
        success: true,
        data: {
          logic: { dataModels: [{ name: 'Item', fields: [{ name: 'id', type: 'string' }] }], rules: [] },
          apiRoutes: [{ method: 'GET', path: '/api/items', handler: 'getItems' }],
          schema: { tables: [{ name: 'items', columns: [{ name: 'id', type: 'string' }] }] }
        }
      };
    }
    if (stage === 'Designer') {
      return {
        success: true,
        data: {
          components: [{ name: 'ItemList', props: ['className'], consumes: 'Item' }],
          styleTokens: { colors: { primary: '#fff' }, spacing: { sm: '8px' }, typography: { sans: 'sans' } }
        }
      };
    }
    if (stage === 'Architect') {
      return {
        success: true,
        data: {
          architecture: { modules: [{ name: 'Browse', type: 'page', responsibility: 'renders browse page' }], techStack: ['react'] },
          fileGraph: [{ file: 'src/pages/Browse.tsx', exports: ['Browse'], imports: [] }]
        }
      };
    }
    if (stage === 'Coder') {
      return {
        success: true,
        data: {
          code: 'export function Browse() { return <div>Browse Page</div>; }'
        }
      };
    }
    if (stage === 'Tester') {
      return {
        success: true,
        data: {
          testFiles: { 'src/__tests__/Browse.test.ts': 'test' },
          failureReport: []
        }
      };
    }
    if (stage === 'Debugger') {
      return {
        success: true,
        data: {
          repairDiffs: []
        }
      };
    }
    if (stage === 'Security') {
      return {
        success: true,
        data: {
          securityReport: { issues: [], scannedAt: Date.now() }
        }
      };
    }
    if (stage === 'Reviewer') {
      return {
        success: true,
        data: {
          qualityScore: 95,
          annotations: []
        }
      };
    }
    if (stage === 'Refiner') {
      return {
        success: true,
        data: {
          scoreBefore: 90,
          scoreExpected: 95,
          optimizations: []
        }
      };
    }
    return { success: false, data: null };
  }),
  isSLMAvailable: () => true,
  checkHealth: async () => {},
  registerStageTemplate: () => {}
}));

describe('RuFlo Parallel DAG Pipeline', () => {
  it('should run the 11 agents in topological sequence and return delivery report', async () => {
    const report = await runRuFloPipeline({
      prompt: 'Build a premium todo application'
    });

    console.log('Pipeline Errors:', report.errors);
    expect(report.ok).toBe(true);
    expect(report.filesGenerated).toBeGreaterThan(0);
    expect(report.qualityScore).toBe(95);
    expect(report.errors).toHaveLength(0);
    expect(report.sourceFiles['src/pages/Browse.tsx']).toContain('Browse Page');
  });
});
