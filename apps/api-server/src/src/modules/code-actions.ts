export interface ActionThinkingStep {
  phase: string;
  label: string;
  detail?: string;
  timestamp?: number;
  reasoning?: string;
  filesAffected?: string[];
}

export type FileActionType = 'CreateFile' | 'ModifyFile' | 'DeleteFile';

export type SemanticActionType =
  | 'AddEntity'
  | 'AddRoute'
  | 'AddPage'
  | 'ModifyStyle'
  | 'ModifyContent'
  | 'AddField'
  | 'ExtractComponent'
  | 'RenameSymbol';

export type CodeActionType = FileActionType | SemanticActionType;

export interface FileActionPayload {
  filePath: string;
  language?: string;
  oldContent?: string;
  newContent?: string;
  linesChanged?: number;
}

export interface AddEntityPayload extends FileActionPayload {
  entityName: string;
  fields?: string[];
}

export interface AddRoutePayload extends FileActionPayload {
  routePath: string;
  method?: string;
  entityName?: string;
}

export interface AddPagePayload extends FileActionPayload {
  pageName: string;
  routePath?: string;
}

export interface ModifyStylePayload extends FileActionPayload {
  targetSelector?: string;
  properties?: Record<string, string>;
}

export interface ModifyContentPayload extends FileActionPayload {
  targetElement?: string;
  oldText?: string;
  newText?: string;
}

export interface AddFieldPayload extends FileActionPayload {
  entityName: string;
  fieldName: string;
  fieldType?: string;
}

export interface ExtractComponentPayload extends FileActionPayload {
  componentName: string;
  sourceFile: string;
  targetFile: string;
}

export interface RenameSymbolPayload extends FileActionPayload {
  oldName: string;
  newName: string;
  symbolType?: 'variable' | 'function' | 'class' | 'component' | 'type';
}

export type CodeActionPayload =
  | FileActionPayload
  | AddEntityPayload
  | AddRoutePayload
  | AddPagePayload
  | ModifyStylePayload
  | ModifyContentPayload
  | AddFieldPayload
  | ExtractComponentPayload
  | RenameSymbolPayload;

export interface ActionPayloadMap {
  CreateFile: FileActionPayload;
  ModifyFile: FileActionPayload;
  DeleteFile: FileActionPayload;
  AddEntity: AddEntityPayload;
  AddRoute: AddRoutePayload;
  AddPage: AddPagePayload;
  ModifyStyle: ModifyStylePayload;
  ModifyContent: ModifyContentPayload;
  AddField: AddFieldPayload;
  ExtractComponent: ExtractComponentPayload;
  RenameSymbol: RenameSymbolPayload;
}

export type CodeActionStatus = 'pending' | 'success' | 'failure' | 'skipped';

interface CodeActionBase {
  id: string;
  stage: string;
  timestamp: number;
  sourceActionId?: string;
  status: CodeActionStatus;
  error?: string;
  description: string;
  retryCount?: number;
  durationMs?: number;
}

export type TypedCodeAction<T extends CodeActionType = CodeActionType> = CodeActionBase & {
  type: T;
  payload: T extends keyof ActionPayloadMap ? ActionPayloadMap[T] : FileActionPayload;
};

export type CodeAction = TypedCodeAction;

let actionCounter = 0;

function generateActionId(type: CodeActionType): string {
  actionCounter++;
  return `${type}-${actionCounter}-${Date.now()}`;
}

export function resetActionCounter(): void {
  actionCounter = 0;
}

export interface ActionContext {
  actions: CodeAction[];
  thinkingSteps: ActionThinkingStep[];
  onStep?: (step: ActionThinkingStep) => void;
}

export function recordAction<T extends CodeActionType>(
  ctx: ActionContext,
  type: T,
  stage: string,
  payload: T extends keyof ActionPayloadMap ? ActionPayloadMap[T] : FileActionPayload,
  description: string,
  options?: {
    sourceActionId?: string;
    emitThinkingStep?: boolean;
    status?: CodeActionStatus;
    error?: string;
  }
): TypedCodeAction<T> {
  const action: TypedCodeAction<T> = {
    id: generateActionId(type),
    type,
    payload,
    stage,
    timestamp: Date.now(),
    sourceActionId: options?.sourceActionId,
    status: options?.status || 'success',
    error: options?.error,
    description,
    retryCount: 0,
  };

  ctx.actions.push(action as CodeAction);

  if (options?.emitThinkingStep !== false) {
    const stepLabel = formatActionLabel(action);
    const step: ActionThinkingStep = {
      phase: stage,
      label: stepLabel,
      detail: description,
      timestamp: Date.now(),
      filesAffected: payload.filePath ? [payload.filePath] : undefined,
    };
    ctx.thinkingSteps.push(step);
    if (ctx.onStep) ctx.onStep(step);
  }

  return action;
}

function getSemanticField<K extends string>(payload: CodeActionPayload, field: K): string | undefined {
  return (payload as unknown as Record<string, unknown>)[field] as string | undefined;
}

function formatActionLabel(action: CodeAction): string {
  const statusIcon = action.status === 'success' ? '✓' : action.status === 'failure' ? '✗' : '→';
  const typeLabel = formatActionType(action.type);
  const p = action.payload;

  switch (action.type) {
    case 'CreateFile':
      return `${statusIcon} Creating ${p.filePath}|||${typeLabel}`;
    case 'ModifyFile':
      return `${statusIcon} Modifying ${p.filePath}|||${typeLabel}`;
    case 'DeleteFile':
      return `${statusIcon} Deleting ${p.filePath}|||${typeLabel}`;
    case 'AddEntity':
      return `${statusIcon} Adding ${getSemanticField(p, 'entityName') || 'entity'} model|||${typeLabel}`;
    case 'AddRoute':
      return `${statusIcon} Adding ${getSemanticField(p, 'method') || ''} ${getSemanticField(p, 'routePath') || 'route'}|||${typeLabel}`;
    case 'AddPage':
      return `${statusIcon} Adding ${getSemanticField(p, 'pageName') || 'page'} page|||${typeLabel}`;
    case 'ModifyStyle':
      return `${statusIcon} Updating styles|||${typeLabel}`;
    case 'ModifyContent':
      return `${statusIcon} Updating content|||${typeLabel}`;
    case 'AddField':
      return `${statusIcon} Adding ${getSemanticField(p, 'fieldName') || 'field'} to ${getSemanticField(p, 'entityName') || 'entity'}|||${typeLabel}`;
    case 'ExtractComponent':
      return `${statusIcon} Extracting ${getSemanticField(p, 'componentName') || 'component'}|||${typeLabel}`;
    case 'RenameSymbol':
      return `${statusIcon} Renaming ${getSemanticField(p, 'oldName') || '?'} → ${getSemanticField(p, 'newName') || '?'}|||${typeLabel}`;
    default:
      return `${statusIcon} ${action.description}|||${typeLabel}`;
  }
}

function formatActionType(type: CodeActionType): string {
  return type.replace(/([A-Z])/g, ' $1').trim();
}

export function classifyEditToActionType(
  editType: string,
  filePath: string,
  description: string
): CodeActionType {
  if (description.toLowerCase().includes('delete') || editType === 'delete') return 'DeleteFile';

  const lower = description.toLowerCase();

  if (/\b(entity|model|schema)\b/.test(lower) && /\b(add|creat|new)\b/.test(lower)) return 'AddEntity';
  if (/\b(route|endpoint|api)\b/.test(lower) && /\b(add|creat|new)\b/.test(lower)) return 'AddRoute';
  if (/\b(page|view|screen)\b/.test(lower) && /\b(add|creat|new)\b/.test(lower)) return 'AddPage';
  if (/\b(field|column|property)\b/.test(lower) && /\b(add|creat|new)\b/.test(lower)) return 'AddField';
  if (/\b(extract|split|separate)\b/.test(lower) && /\b(component)\b/.test(lower)) return 'ExtractComponent';
  if (/\b(rename|refactor)\b/.test(lower)) return 'RenameSymbol';
  if (/\b(style|css|color|font|spacing|margin|padding|theme|dark\s*mode)\b/.test(lower)) return 'ModifyStyle';
  if (/\b(text|content|title|heading|label|copy|wording)\b/.test(lower)) return 'ModifyContent';

  if (editType === 'create') return 'CreateFile';
  return 'ModifyFile';
}

export function getActionSummary(actions: CodeAction[]): {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  byType: Record<string, number>;
  byStage: Record<string, number>;
} {
  const summary = {
    total: actions.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    byType: {} as Record<string, number>,
    byStage: {} as Record<string, number>,
  };

  for (const action of actions) {
    if (action.status === 'success') summary.succeeded++;
    else if (action.status === 'failure') summary.failed++;
    else if (action.status === 'skipped') summary.skipped++;

    summary.byType[action.type] = (summary.byType[action.type] || 0) + 1;
    summary.byStage[action.stage] = (summary.byStage[action.stage] || 0) + 1;
  }

  return summary;
}

export function executeActionWithRetry<T>(
  actionFn: () => T,
  action: CodeAction,
  maxRetries: number = 1
): { result: T | null; action: CodeAction } {
  const startTime = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = actionFn();
      action.status = 'success';
      action.retryCount = attempt;
      action.durationMs = Date.now() - startTime;
      return { result, action };
    } catch (err) {
      action.retryCount = attempt;
      if (attempt >= maxRetries) {
        action.status = 'failure';
        action.error = err instanceof Error ? err.message : String(err);
        action.durationMs = Date.now() - startTime;
        return { result: null, action };
      }
    }
  }

  action.status = 'failure';
  action.durationMs = Date.now() - startTime;
  return { result: null, action };
}

export async function executeAsyncActionWithRetry<T>(
  actionFn: () => Promise<T>,
  action: CodeAction,
  maxRetries: number = 1
): Promise<{ result: T | null; action: CodeAction }> {
  const startTime = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await actionFn();
      action.status = 'success';
      action.retryCount = attempt;
      action.durationMs = Date.now() - startTime;
      return { result, action };
    } catch (err) {
      action.retryCount = attempt;
      if (attempt >= maxRetries) {
        action.status = 'failure';
        action.error = err instanceof Error ? err.message : String(err);
        action.durationMs = Date.now() - startTime;
        return { result: null, action };
      }
    }
  }

  action.status = 'failure';
  action.durationMs = Date.now() - startTime;
  return { result: null, action };
}

export function buildActionProgressMessage(actions: CodeAction[]): string {
  const recent = actions.slice(-5);
  const parts: string[] = [];

  for (const action of recent) {
    const p = action.payload;
    switch (action.type) {
      case 'AddEntity':
        parts.push(`Creating ${getSemanticField(p, 'entityName') || 'entity'} model`);
        break;
      case 'AddRoute':
        parts.push(`Adding ${getSemanticField(p, 'routePath') || 'route'} routes`);
        break;
      case 'AddPage':
        parts.push(`Wiring ${getSemanticField(p, 'pageName') || 'page'} page`);
        break;
      case 'AddField':
        parts.push(`Adding ${getSemanticField(p, 'fieldName') || 'field'} field`);
        break;
      case 'CreateFile':
        parts.push(`Creating ${p.filePath?.split('/').pop() || 'file'}`);
        break;
      case 'ModifyFile':
        parts.push(`Updating ${p.filePath?.split('/').pop() || 'file'}`);
        break;
      case 'ModifyStyle':
        parts.push('Updating styles');
        break;
      case 'ModifyContent':
        parts.push('Updating content');
        break;
      default:
        parts.push(action.description.slice(0, 40));
    }
  }

  return parts.join(' → ');
}
