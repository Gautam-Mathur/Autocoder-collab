/**
 * DESIGNER — UI component owner (Fusion mode).
 * Wraps AutoCoder's `design-system-engine.generateDesignSystem`,
 * `functionality-engine.generateFunctionalitySpec`, and
 * `component-composer.composeComponents`. Writes designSystem,
 * functionalitySpec, and componentTree back to legacyCtx so the Coder
 * (generateProjectFromPlan) can consume them.
 *
 * Reads:  legacyCtx.plan, legacyCtx.reasoning, legacyCtx.detectedDomain
 * Writes: DesignerOutput { components, styleTokens }
 */

import { ExecutiveMemory } from '../executive-memory.js';
import { StageLedger } from '../stage-ledger.js';
import type { AgentRunContext } from '../agent-runner.js';
import type {
  ArchitectOutput,
  ComponentSpec,
  DesignerOutput,
  StyleTokens,
  SystemOutput,
} from '../types.js';

export async function runDesigner(
  _mem: ExecutiveMemory,
  ledger: StageLedger,
  runCtx: AgentRunContext,
): Promise<DesignerOutput> {
  const architect = ledger.read('Designer', 'architect') as ArchitectOutput | null;
  const system = ledger.read('Designer', 'system') as SystemOutput | null;
  if (!architect) throw new Error('Designer: missing architect output');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = runCtx.legacyCtx as any | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let componentTree: any | null = null;

  if (ctx?.plan) {
    try {
      const ds = await import('../../design-system-engine.js');
      const designSystem = ds.generateDesignSystem(ctx.plan, ctx.reasoning ?? undefined);
      ctx.designSystem = designSystem;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[RuFlo:Designer] generateDesignSystem failed:', (e as Error).message);
    }
    try {
      const fe = await import('../../functionality-engine.js');
      if (ctx.reasoning) {
        const funcSpec = fe.generateFunctionalitySpec(ctx.plan, ctx.reasoning);
        ctx.functionalitySpec = funcSpec;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[RuFlo:Designer] generateFunctionalitySpec failed:', (e as Error).message);
    }
    try {
      const cc = await import('../../component-composer.js');
      componentTree = cc.composeComponents(
        ctx.plan,
        ctx.reasoning ?? null,
        ctx.functionalitySpec ?? null,
        ctx.designSystem ?? null,
        ctx.detectedDomain,
      );
      ctx.componentTree = componentTree;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[RuFlo:Designer] composeComponents failed:', (e as Error).message);
    }
  }

  const components: ComponentSpec[] = [];

  // Project from real componentTree if available.
  if (componentTree?.components && Array.isArray(componentTree.components)) {
    for (const c of componentTree.components) {
      components.push({
        name: String(c.name ?? c.id ?? 'Component'),
        props: Array.isArray(c.props) ? c.props.map((p: { name?: string } | string) => typeof p === 'string' ? p : (p.name ?? 'prop')) : ['className'],
        consumes: typeof c.consumes === 'string' ? c.consumes : matchEntity(String(c.name ?? ''), system),
      });
    }
  } else {
    for (const m of architect.architecture.modules) {
      components.push({ name: m.name, props: ['className'], consumes: matchEntity(m.name, system) });
    }
  }

  // Guarantee Contract 2 — every data model has a UI consumer.
  if (system) {
    const consumed = new Set(components.map((c) => c.consumes).filter((x): x is string => Boolean(x)));
    for (const model of system.logic.dataModels) {
      if (!consumed.has(model.name)) {
        components.push({ name: `${model.name}List`, props: ['filters'], consumes: model.name });
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dsTokens = (ctx?.designSystem as any)?.tokens ?? {};
  const styleTokens: StyleTokens = {
    colors: dsTokens.colors ?? {
      primary: '#3b82f6', secondary: '#8b5cf6', background: '#ffffff', foreground: '#0f172a', muted: '#f1f5f9',
    },
    spacing: dsTokens.spacing ?? { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px' },
    typography: dsTokens.typography ?? { sans: 'Inter, system-ui, sans-serif', mono: 'ui-monospace, monospace' },
  };

  return { components, styleTokens };
}

function matchEntity(componentName: string, system: SystemOutput | null): string | undefined {
  if (!system) return undefined;
  const lower = componentName.toLowerCase();
  for (const m of system.logic.dataModels) {
    if (lower.includes(m.name.toLowerCase())) return m.name;
  }
  return undefined;
}
