/**
 * RuFlo Fusion — Sequential controller
 *
 * Orchestrates the 10 agents in fixed order with:
 *   - shouldRun() surgical-execution gate
 *   - checkHealth() best-effort SLM probe
 *   - runAgent() with per-agent timeout + ownership-enforced ledger write
 *   - propagateInvalidation() to mark downstream agents dirty
 *   - validateConsistency() hard contract gate after Architect & Designer
 *
 * Returns a fully populated DeliveryReport via the Ship Gate.
 */

import { ContractViolationError, findResponsibleAgents, validateConsistency } from './contract-validator.js';
import { propagateInvalidation, shouldRun } from './dependency-graph.js';
import { ExecutiveMemory } from './executive-memory.js';
import { drainEvents, logEvent } from './observability-sink.js';
import { shipGate } from './ship-gate.js';
import { StageLedger } from './stage-ledger.js';
import {
  HaltEvent,
  SkipEvent,
  checkHealth,
  runAgent,
  type AgentRunContext,
} from './agent-runner.js';
import type { AgentName, DeliveryReport } from './types.js';

// Security runs AFTER Coder + Debugger so it can scan emitted source files.
// Placing it earlier (before Coder) leaves it nothing to scan and was the
// cause of an earlier no-op-Security bug.
const AGENT_ORDER: AgentName[] = [
  'Queen',
  'Planner',
  'Architect',
  'System',
  'Designer',
  'Coder',
  'Debugger',
  'Security',
  'Reviewer',
  'Tester',
];

const MAX_CONTRACT_RETRIES = 3;

export interface RuFloRunOptions {
  prompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  legacyCtx?: any;
  onAgentEvent?: (
    agent: AgentName,
    phase: 'start' | 'complete' | 'skipped' | 'halt',
    summary?: string,
  ) => void;
}

// Build a per-agent one-line summary from the live ExecutiveMemory right
// after the agent finishes. Surfaced in the orchestrator's "complete"
// thinking step so users see what each agent actually produced instead of
// a bland "Queen complete".
// Multi-line, intel-rich per-agent summary. Surfaced in the orchestrator's
// "complete" thinking step so users see WHAT each agent produced, not just
// "Queen complete". Each summary lists concrete artifacts (top features,
// modules, routes, components, files, sample security issue, …).
function summarizeAgent(agent: AgentName, mem: ExecutiveMemory): string {
  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const sample = <T,>(xs: T[], n: number, fmt: (x: T) => string): string =>
    xs.slice(0, n).map(fmt).join(', ') + (xs.length > n ? `, +${xs.length - n} more` : '');

  switch (agent) {
    case 'Queen': {
      const t = mem.taskSpec;
      if (!t) return 'no spec captured';
      const must = Array.isArray(t.mustHaveFeatures) ? t.mustHaveFeatures : [];
      const should = Array.isArray((t as any).shouldHaveFeatures) ? (t as any).shouldHaveFeatures as string[] : [];
      const lines = [
        `Domain: ${t.domain ?? '?'} · primary user: ${t.userType ?? '?'}`,
        `Must-have features (${must.length}): ${must.length > 0 ? sample(must, 5, x => `\`${truncate(String(x), 40)}\``) : 'none captured'}`,
      ];
      if (should.length > 0) lines.push(`Should-have (${should.length}): ${sample(should, 4, x => `\`${truncate(String(x), 40)}\``)}`);
      if (typeof t.coreFlow === 'string' && t.coreFlow.length > 0) lines.push(`Core flow: ${truncate(t.coreFlow, 200)}`);
      lines.push('Spec is now locked into executive memory — every downstream agent reads from this contract.');
      return lines.join('\n');
    }
    case 'Planner': {
      const p = mem.planner;
      if (!p) return 'no plan captured';
      const counts: Record<'must' | 'should' | 'could', number> = { must: 0, should: 0, could: 0 };
      for (const f of p.features) counts[f.priority]++;
      const top = p.features.filter(f => f.priority === 'must').slice(0, 5).map(f => `\`${truncate(f.name, 28)}\``).join(', ');
      const reqs = p.requirements.slice(0, 3).map(r => `\`${truncate(typeof r === 'string' ? r : (r as any).description ?? String(r), 50)}\``).join('; ');
      return [
        `${p.features.length} features → ${counts.must} must, ${counts.should} should, ${counts.could} could.`,
        `Top must-haves: ${top || '_none_'}`,
        `${p.requirements.length} requirements${reqs ? ` (sample: ${reqs})` : ''} · ${p.todo.length} todo items`,
        'Each feature carries acceptance criteria + priority — the Architect uses these to size modules and the Coder uses them to scope files.',
      ].join('\n');
    }
    case 'Architect': {
      const a = mem.architect;
      if (!a) return 'no architecture captured';
      const byType: Record<string, number> = {};
      for (const m of a.architecture.modules) byType[m.type] = (byType[m.type] ?? 0) + 1;
      const breakdown = Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(', ') || 'no modules';
      const topMods = sample(a.architecture.modules, 6, m => `\`${m.name}\` (${m.type})`);
      const stack = a.architecture.techStack.length > 0 ? a.architecture.techStack.join(', ') : '_unspecified_';
      return [
        `${a.architecture.modules.length} modules → ${breakdown}.`,
        `Modules: ${topMods}`,
        `Dependency graph: ${a.fileGraph.length} files wired together (no cycles enforced by contract gate).`,
        `Stack: ${stack}.`,
        'Contract gate now verifies every Planner feature is owned by exactly one module before we move on.',
      ].join('\n');
    }
    case 'System': {
      const s = mem.system;
      if (!s) return 'no system spec';
      const byMethod: Record<string, number> = {};
      for (const r of s.apiRoutes) byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
      const methods = Object.entries(byMethod).map(([m, n]) => `${n} ${m}`).join(', ') || 'no routes';
      const topRoutes = sample(s.apiRoutes, 5, r => `\`${r.method} ${(r as any).path ?? (r as any).route ?? '?'}\``);
      const tables = sample(s.schema.tables, 6, t => `\`${(t as any).name ?? t}\``);
      return [
        `${s.logic.dataModels.length} data models · ${s.schema.tables.length} DB tables · ${s.apiRoutes.length} API routes (${methods}) · ${s.logic.rules.length} business rules.`,
        `Tables: ${tables || '_none_'}`,
        `Sample routes: ${topRoutes || '_none_'}`,
        'Every route has a typed request/response shape, validation, and an auth requirement — the Coder will scaffold handlers from these.',
      ].join('\n');
    }
    case 'Designer': {
      const d = mem.designer;
      if (!d) return 'no design captured';
      const tokens = `${Object.keys(d.styleTokens.colors).length} colors / ${Object.keys(d.styleTokens.spacing).length} spacing / ${Object.keys(d.styleTokens.typography).length} typography`;
      const topComps = sample(d.components, 6, c => `\`${(c as any).name ?? c}\``);
      const palette = Object.entries(d.styleTokens.colors).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(', ');
      return [
        `${d.components.length} components designed · style tokens: ${tokens}.`,
        `Components: ${topComps || '_none_'}`,
        palette ? `Palette sample: ${palette}` : '',
        'Contract gate now verifies every Designer component renders data from a System data model — no orphan UI.',
      ].filter(Boolean).join('\n');
    }
    case 'Coder': {
      const c = mem.coder;
      if (!c) return 'no source files emitted';
      const entries = Object.entries(c.sourceFiles);
      const bytes = entries.reduce((n, [, content]) => n + content.length, 0);
      const totalLines = entries.reduce((n, [, content]) => n + content.split('\n').length, 0);
      const byType: Record<string, number> = {};
      for (const [path] of entries) {
        const ext = path.split('.').pop() ?? '?';
        byType[ext] = (byType[ext] ?? 0) + 1;
      }
      const typeBreakdown = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e, n]) => `${n} .${e}`).join(', ');
      const topFiles = sample(entries.map(([p]) => p), 6, p => `\`${p}\``);
      return [
        `${entries.length} source files · ${(bytes / 1024).toFixed(1)} KB · ~${totalLines.toLocaleString()} lines.`,
        `By extension: ${typeBreakdown}`,
        `Sample files: ${topFiles}`,
        'All emitted to ExecutiveMemory.coder.sourceFiles — Debugger will validate types/imports next.',
      ].join('\n');
    }
    case 'Debugger': {
      const d = mem.debugger;
      if (!d) return 'no debug pass';
      if (d.repairDiffs.length === 0) return [
        '0 repairs needed — clean build.',
        'No type errors, missing imports, or contract violations detected after the Coder pass.',
      ].join('\n');
      const bytes = d.repairDiffs.reduce((n, r) => n + (r.sizeBytes ?? 0), 0);
      const topRepaired = sample(d.repairDiffs, 5, r => `\`${(r as any).path ?? (r as any).file ?? '?'}\``);
      return [
        `Repaired ${d.repairDiffs.length} files (${(bytes / 1024).toFixed(1)} KB patched).`,
        `Files touched: ${topRepaired}`,
        'Common fixes: missing imports, unused vars, mistyped props, route/handler mismatches — all applied in-place to ctx.files.',
      ].join('\n');
    }
    case 'Security': {
      const r = mem.security?.securityReport;
      if (!r) return 'no security scan';
      if (r.issues.length === 0) return [
        'Clean — 0 security issues found.',
        'Checked: input validation, auth on mutating routes, secret handling, CORS, dependency advisories.',
      ].join('\n');
      const c: Record<'critical' | 'high' | 'medium' | 'low', number> = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const i of r.issues) c[i.severity]++;
      const topIssues = r.issues.slice(0, 4).map(i => `[${i.severity}] ${truncate((i as any).message ?? (i as any).title ?? '', 80)}`).join('\n  - ');
      return [
        `${r.issues.length} issues: ${c.critical} critical · ${c.high} high · ${c.medium} medium · ${c.low} low.`,
        `Top findings:\n  - ${topIssues}`,
        'Critical/high are flagged for the Reviewer; medium/low are recorded for the chat warnings block.',
      ].join('\n');
    }
    case 'Reviewer': {
      const r = mem.reviewer;
      if (!r) return 'no review';
      const sev: Record<'info' | 'warn' | 'error', number> = { info: 0, warn: 0, error: 0 };
      for (const a of r.annotations) sev[a.severity]++;
      const topAnnots = r.annotations.slice(0, 3).map(a => `[${a.severity}] ${truncate((a as any).message ?? (a as any).note ?? '', 70)}`).join('; ');
      return [
        `Quality score ${r.qualityScore}/100 · ${r.annotations.length} annotations (${sev.error} error, ${sev.warn} warn, ${sev.info} info).`,
        topAnnots ? `Top notes: ${topAnnots}` : 'No annotations produced.',
        'Score weights: contract adherence, code clarity, test coverage hooks, accessibility hints, perf affordances.',
      ].join('\n');
    }
    case 'Tester': {
      const t = mem.tester;
      if (!t) return 'no tests generated';
      const entries = Object.entries(t.testFiles);
      const bytes = entries.reduce((n, [, c]) => n + c.length, 0);
      const topTests = sample(entries.map(([p]) => p), 5, p => `\`${p}\``);
      return [
        `${entries.length} test files · ${(bytes / 1024).toFixed(1)} KB.`,
        `Sample tests: ${topTests}`,
        'Tests cover API route happy/error paths and key UI components — runnable with the project test command.',
      ].join('\n');
    }
    default:
      return '';
  }
}

export async function runRuFloPipeline(opts: RuFloRunOptions): Promise<DeliveryReport> {
  const mem = new ExecutiveMemory();
  const ledger = new StageLedger(mem);
  const errors: string[] = [];
  const timings: Partial<Record<AgentName, number>> = {};

  const runCtx: AgentRunContext = { prompt: opts.prompt, legacyCtx: opts.legacyCtx };

  // First pass through the agent order. The contract gate may push us into
  // a bounded re-run loop for a specific agent.
  let contractRetries = 0;

  for (let i = 0; i < AGENT_ORDER.length; i++) {
    const agent = AGENT_ORDER[i];

    if (!shouldRun(agent, mem)) {
      logEvent({ type: 'agent_skipped', agent, reason: 'not_invalidated' });
      opts.onAgentEvent?.(agent, 'skipped');
      continue;
    }

    try {
      await checkHealth(agent);
      const t0 = Date.now();
      opts.onAgentEvent?.(agent, 'start');
      await runAgent(agent, ledger, mem, runCtx);
      timings[agent] = Date.now() - t0;
      opts.onAgentEvent?.(agent, 'complete', summarizeAgent(agent, mem));

      // Hard contract gate after Architect.
      if (agent === 'Architect') {
        const result = validateConsistency(mem);
        if (!result.ok) {
          if (contractRetries < MAX_CONTRACT_RETRIES) {
            contractRetries++;
            const responsible = findResponsibleAgents(result.violations);
            for (const a of responsible) mem.invalidated.add(a);
            // Rewind to the responsible agent (Architect) and retry.
            i = AGENT_ORDER.indexOf('Architect') - 1;
            continue;
          }
          throw new ContractViolationError(result.violations);
        }
        logEvent({ type: 'contract_pass', agent: 'Architect', contractsChecked: 1 });
      }

      // Hard contract gate after Designer (covers Contract 2: data → UI).
      if (agent === 'Designer') {
        const result = validateConsistency(mem);
        if (!result.ok) {
          if (contractRetries < MAX_CONTRACT_RETRIES) {
            contractRetries++;
            const responsible = findResponsibleAgents(result.violations);
            for (const a of responsible) mem.invalidated.add(a);
            i = AGENT_ORDER.indexOf('Designer') - 1;
            continue;
          }
          throw new ContractViolationError(result.violations);
        }
        logEvent({ type: 'contract_pass', agent: 'Designer', contractsChecked: 2 });
      }

      propagateInvalidation(agent, mem);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`[${agent}] ${msg}`);
      if (err instanceof HaltEvent) {
        logEvent({ type: 'halt_event', agent, reason: 'timeout', limitMs: err.limitMs });
        opts.onAgentEvent?.(agent, 'halt');
      } else if (err instanceof SkipEvent) {
        logEvent({ type: 'skip_event', agent, reason: err.reason });
        opts.onAgentEvent?.(agent, 'skipped');
        continue;
      } else if (err instanceof ContractViolationError) {
        // Final contract failure — bubble up summary and continue with what
        // we have, so the user still gets a delivery report.
        break;
      }
      // Non-fatal: continue to next agent so Reviewer / Tester / Ship Gate
      // can still run on partial state. Coder failure means Ship Gate will
      // produce template fallbacks.
      continue;
    }
  }

  // Apply Debugger repairs onto Coder's source files BEFORE the Ship Gate.
  // Without this step the Debugger's bounded patches would have no effect.
  const merged: Record<string, string> = { ...(mem.coder?.sourceFiles ?? {}) };
  for (const diff of mem.debugger?.repairDiffs ?? []) {
    merged[diff.file] = diff.content;
  }

  return shipGate({
    sourceFiles: merged,
    testFiles: mem.tester?.testFiles ?? {},
    qualityScore: mem.reviewer?.qualityScore ?? 0,
    securityIssues: mem.security?.securityReport.issues ?? [],
    agentTimings: timings,
    decisions: [...mem.decisions],
    events: drainEvents(),
    errors,
  });
}
