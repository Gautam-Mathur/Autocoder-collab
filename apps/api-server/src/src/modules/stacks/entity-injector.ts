/**
 * Entity Injector — extracts entities from a ProjectPlan and feeds them into the template engine
 */

import type { ProjectPlan, PlannedEntity } from '../plan-generator.js';
import { buildTemplateContext, generateFromTemplates } from './template-engine.js';
import type { GeneratedFile } from '../pipeline-orchestrator.js';

function inferEntityFields(entity: PlannedEntity): Array<{ name: string; type: string; required: boolean }> {
  const base = [
    { name: 'id', type: 'number', required: true },
    { name: 'createdAt', type: 'Date', required: true },
  ];

  if (!entity.fields || entity.fields.length === 0) {
    return [{ name: 'name', type: 'string', required: true }, ...base];
  }

  return [
    ...entity.fields.map(f => ({
      name: f.name,
      type: mapFieldType(f.type),
      required: f.required !== false,
    })),
    ...base,
  ];
}

function mapFieldType(type: string): string {
  const lower = (type || '').toLowerCase();
  if (lower.includes('int') || lower.includes('number') || lower.includes('float')) return 'number';
  if (lower.includes('bool')) return 'boolean';
  if (lower.includes('date') || lower.includes('time')) return 'Date';
  if (lower.includes('string[]') || lower.includes('array')) return 'string[]';
  return 'string';
}

export async function injectEntitiesToTemplates(
  plan: ProjectPlan,
  stack: string,
): Promise<GeneratedFile[]> {
  const entities = (plan.dataModel || []).map(e => ({
    name: e.name,
    fields: inferEntityFields(e),
  }));

  if (entities.length === 0) {
    entities.push({ name: 'Item', fields: [{ name: 'name', type: 'string', required: true }] });
  }

  const ctx = buildTemplateContext(
    plan.projectName || 'MyApp',
    plan.overview || '',
    entities,
    stack,
    3001,
  );

  return (await generateFromTemplates(ctx)).map(f => ({
    path: f.path,
    content: f.content,
    language: detectLanguage(f.path),
  }));
}

function detectLanguage(path: string): string {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.go')) return 'go';
  if (path.endsWith('.java')) return 'java';
  if (path.endsWith('.cs')) return 'csharp';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
  return 'text';
}
