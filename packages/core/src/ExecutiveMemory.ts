export type AgentStage =
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

export interface ExecutiveMemoryDecision {
  agent: AgentStage;
  field: string;
  value: unknown;
  timestamp: number;
  rationale?: string;
}

export interface AmendmentRequest {
  requestor: AgentStage;
  field: string;
  value: unknown;
  rationale?: string;
  timestamp: number;
  status: 'pending' | 'approved' | 'rejected';
}

// ─── Strongly Typed Memory Shapes ───────────────────────────────────────

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

export interface Annotation {
  file: string;
  note: string;
  agent: AgentStage;
  severity: 'info' | 'warn' | 'error';
}

export interface ReviewerOutput {
  qualityScore: number;
  annotations: Annotation[];
}

export interface TesterOutput {
  testFiles: Record<string, string>;
}

// ─── Executive Memory Class ─────────────────────────────────────────────

export class ExecutiveMemory {
  taskSpec: TaskSpec | null = null;
  planner: PlannerOutput | null = null;
  architect: ArchitectOutput | null = null;
  system: SystemOutput | null = null;
  designer: DesignerOutput | null = null;
  coder: CoderOutput | null = null;
  debugger: DebuggerOutput | null = null;
  security: SecurityReport | null = null;
  reviewer: ReviewerOutput | null = null;
  tester: TesterOutput | null = null;

  decisions: ExecutiveMemoryDecision[] = [];
  invalidated: Set<AgentStage> = new Set();
  amendmentRequests: AmendmentRequest[] = [];

  clearInvalidated(): void {
    this.invalidated.clear();
  }
}

export default ExecutiveMemory;
