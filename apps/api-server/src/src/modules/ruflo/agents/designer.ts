/**
 * DESIGNER — UI component owner
 * Designing components and style tokens.
 *
 * Reads:  mem.taskSpec, mem.planner, mem.system (optional)
 * Writes: DesignerOutput { components, styleTokens }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import { runSLM, registerStageTemplate } from '../../slm-inference-engine.js';
import type { AgentRunContext } from '../agent-runner.js';
import type {
  ComponentSpec,
  DesignerOutput,
  StyleTokens,
  SystemOutput,
  PlannerOutput,
  TaskSpec,
} from '../types.js';

registerStageTemplate({
  stage: 'Designer',
  systemPrompt: `You are the Designer agent in a multi-agent system.
Your job is to read the Queen's task specification, the Planner's features, and optional System data models, and then design the UI components and style tokens (colors, spacing, typography).
Specifically, you must generate a JSON object with:
1. components: List of UI components. Each has:
   - name: Pascal-case name of the component (e.g. "Navbar", "UserList", "CreateProjectForm")
   - props: Array of prop names as strings (e.g. ["className", "onSelect", "items"])
   - consumes: Name of the data model this component consumes/displays (optional)
2. styleTokens:
   - colors: Record mapping key names (e.g. primary, secondary, background, foreground, muted) to hex colors
   - spacing: Record mapping sizes (e.g. xs, sm, md, lg, xl) to size values (e.g. "8px", "16px")
   - typography: Record mapping typographic styles (e.g. sans, mono) to font stacks

IMPORTANT CONTRACT REQUIREMENT: If System data models are provided in the input, ensure that EVERY data model name has at least one UI component in the components list that consumes it (declaring it in the consumes property).

Focus on this instruction: "{agentTask}"`,
  userPromptBuilder: (context: Record<string, any>) => `Queen's Task Specification:\n${JSON.stringify(context.taskSpec, null, 2)}\n\nPlanner's Output:\n${JSON.stringify(context.planner, null, 2)}\n\nSystem Output (if available):\n${context.system ? JSON.stringify(context.system, null, 2) : 'Not available yet'}`,
  outputSchema: {
    type: 'object',
    properties: {
      components: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            props: { type: 'array', items: { type: 'string' } },
            consumes: { type: 'string' }
          },
          required: ['name', 'props']
        }
      },
      styleTokens: {
        type: 'object',
        properties: {
          colors: { type: 'object', additionalProperties: { type: 'string' } },
          spacing: { type: 'object', additionalProperties: { type: 'string' } },
          typography: { type: 'object', additionalProperties: { type: 'string' } }
        },
        required: ['colors', 'spacing', 'typography']
      }
    },
    required: ['components', 'styleTokens']
  },
  maxTokens: 1536,
  temperature: 0.2
});

export async function runDesigner(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<DesignerOutput> {
  const planner = ledger.read('Designer', 'planner') as PlannerOutput | null;
  const spec = ledger.read('Designer', 'taskSpec') as TaskSpec | null;
  if (!planner || !spec) throw new Error('Designer: missing planner or taskSpec output');

  const system = ledger.read('Designer', 'system') as SystemOutput | null;
  const agentTask = spec.agentTasks?.Designer || 'Establish design tokens and UI components.';

  const slmResult = await runSLM<DesignerOutput>('Designer', { taskSpec: spec, planner, system, agentTask });
  if (slmResult.success && slmResult.data) {
    return slmResult.data;
  }

  // Standalone rule-based fallback.
  const components: ComponentSpec[] = planner.features.map((f) => ({
    name: pascalCase(f.name),
    props: ['className'],
    consumes: matchEntity(f.name, system),
  }));

  // Guarantee Contract 2 — every data model has a UI consumer.
  if (system) {
    const consumed = new Set(components.map((c) => c.consumes).filter((x): x is string => Boolean(x)));
    for (const model of system.logic.dataModels) {
      if (!consumed.has(model.name)) {
        components.push({ name: `${model.name}List`, props: ['filters'], consumes: model.name });
      }
    }
  }

  const styleTokens: StyleTokens = {
    colors: {
      primary: '#3b82f6', secondary: '#8b5cf6', background: '#ffffff', foreground: '#0f172a', muted: '#f1f5f9',
    },
    spacing: { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px' },
    typography: { sans: 'Inter, system-ui, sans-serif', mono: 'ui-monospace, monospace' },
  };

  return { components, styleTokens };
}

function pascalCase(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Component';
}
function matchEntity(componentName: string, system: SystemOutput | null): string | undefined {
  if (!system) return undefined;
  const lower = componentName.toLowerCase();
  for (const m of system.logic.dataModels) {
    if (lower.includes(m.name.toLowerCase())) return m.name;
  }
  return undefined;
}
