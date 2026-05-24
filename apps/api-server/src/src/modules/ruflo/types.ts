/**
 * RuFlo Fusion — Shared types
 *
 * Single source of truth for AgentName, ExecutiveMemory field shapes,
 * contract violations, observability events, and delivery report schema.
 */

export type AgentName =
  | 'Queen'
  | 'Planner'
  | 'Architect'
  | 'System'
  | 'Designer'
  | 'Coder'
  | 'Debugger'
  | 'Security'
  | 'Reviewer'
  | 'Tester';

// ─── Specification phase ────────────────────────────────────────────────

export interface TaskSpec {
  domain: string;
  userType: string;
  coreFlow: string;
  mustHaveFeatures: string[];
  explicitNonGoals: string[];
}

export interface Feature {
  id: string;
  name: string;
  acceptanceCriteria: string[];
  priority: 'must' | 'should' | 'could';
}

export interface Requirement {
  id: string;
  description: string;
  type: 'functional' | 'non-functional';
}

export interface TodoItem {
  id: string;
  description: string;
  done: boolean;
}

export interface PlannerOutput {
  features: Feature[];
  requirements: Requirement[];
  todo: TodoItem[];
}

export interface ArchitectureModule {
  name: string;
  type: 'page' | 'component' | 'api' | 'lib' | 'service';
  responsibility?: string;
}

export interface ArchitectureSpec {
  modules: ArchitectureModule[];
  techStack: string[];
}

export interface FileNode {
  file: string;
  exports: string[];
  imports: string[];
}

export interface ArchitectOutput {
  architecture: ArchitectureSpec;
  fileGraph: FileNode[];
}

// ─── Implementation phase ───────────────────────────────────────────────

export interface DataModel {
  name: string;
  fields: Array<{ name: string; type: string; required?: boolean }>;
}

export interface LogicSpec {
  dataModels: DataModel[];
  rules: Array<{ name: string; description: string }>;
}

export interface ApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  handler: string;
  consumes?: string;
  produces?: string;
}

export interface SchemaSpec {
  tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
}

export interface SystemOutput {
  logic: LogicSpec;
  apiRoutes: ApiRoute[];
  schema: SchemaSpec;
}

export interface ComponentSpec {
  name: string;
  props: string[];
  consumes?: string;
}

export interface StyleTokens {
  colors: Record<string, string>;
  spacing: Record<string, string>;
  typography: Record<string, string>;
}

export interface DesignerOutput {
  components: ComponentSpec[];
  styleTokens: StyleTokens;
}

export interface CoderOutput {
  sourceFiles: Record<string, string>;
}

// ─── Verification phase ─────────────────────────────────────────────────

export interface RepairDiff {
  file: string;
  content: string;
  source: string;
  sizeBytes: number;
}

export interface DebuggerOutput {
  repairDiffs: RepairDiff[];
}

export interface SecurityIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  location?: string;
}

export interface SecurityReport {
  issues: SecurityIssue[];
  scannedAt: number;
}

export interface SecurityOutput {
  securityReport: SecurityReport;
}

export interface Annotation {
  file: string;
  note: string;
  agent: AgentName;
  severity: 'info' | 'warn' | 'error';
}

export interface ReviewerOutput {
  qualityScore: number;
  annotations: Annotation[];
}

export interface TesterOutput {
  testFiles: Record<string, string>;
}

// ─── Decision audit ─────────────────────────────────────────────────────

export interface DecisionLog {
  agent: AgentName;
  field: string;
  value: unknown;
  timestamp: number;
  rationale?: string;
}

// ─── Contract violations ────────────────────────────────────────────────

export interface ContractViolation {
  contract: 'planner→architect' | 'system→designer';
  missing: string;
  responsibleAgent: AgentName;
  description: string;
}

export interface ContractResult {
  ok: boolean;
  violations: ContractViolation[];
}

// ─── Observability events ───────────────────────────────────────────────

export type ObservabilityEvent =
  | { type: 'agent_start'; agent: AgentName; timestamp: number }
  | { type: 'agent_complete'; agent: AgentName; durationMs: number }
  | { type: 'agent_skipped'; agent: AgentName; reason: 'not_invalidated' | 'health_fail' }
  | { type: 'drift_event'; agent: AgentName; field: string }
  | { type: 'contract_violation'; contract: string; missing: string; responsible: AgentName }
  | { type: 'contract_pass'; agent: AgentName; contractsChecked: number }
  | { type: 'invalidation_propagated'; source: AgentName; affected: AgentName[]; total: number }
  | { type: 'patch_oversized'; agent: AgentName; file: string; size: number; limit: number }
  | { type: 'slm_unavailable'; agent: AgentName; fallback: 'rules-only' }
  | { type: 'halt_event'; agent: AgentName; reason: 'timeout'; limitMs: number }
  | { type: 'skip_event'; agent: AgentName; reason: string }
  | { type: 'kb_injected'; agent: AgentName; tokenCount: number }
  | { type: 'kb_blocked'; agent: AgentName; reason: 'not_in_allowed_phase' }
  | { type: 'ship_gate_pass'; filesChecked: number; repairsApplied: number }
  | { type: 'ship_gate_fallback'; file: string; layer: 1 | 2 | 3 };

// ─── Delivery report ────────────────────────────────────────────────────

export interface DeliveryReport {
  ok: boolean;
  filesGenerated: number;
  repairAttemptsUsed: number;
  fallbacksTriggered: number;
  qualityScore: number;
  securityIssues: SecurityIssue[];
  importErrorsFixed: number;
  crossFileErrorsFixed: number;
  agentTimings: Partial<Record<AgentName, number>>;
  decisions: DecisionLog[];
  events: ObservabilityEvent[];
  sourceFiles: Record<string, string>;
  testFiles: Record<string, string>;
  errors: string[];
}
