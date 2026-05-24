/**
 * Repo Indexer — extracts a searchable symbol index from fetched files
 *
 * For each source file extracts:
 *   - Exported functions / classes / interfaces / constants
 *   - Import graph (what each file imports)
 *   - API endpoints (Express routes, Django URLs, Spring @GetMapping, etc.)
 *   - DB models (Drizzle pgTable, Mongoose model, Django models.Model, JPA @Entity)
 *
 * Returns a compact RepoIndex usable for RAG context injection.
 */

import type { FetchedFile } from './github-service.js';

export interface Symbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'const' | 'type' | 'enum' | 'model' | 'endpoint';
  file: string;
  line?: number;
  signature?: string;
}

export interface RepoIndex {
  repoName: string;
  language: string;
  framework?: string;
  symbols: Symbol[];
  endpoints: string[];
  models: string[];
  importGraph: Record<string, string[]>;
  fileSummaries: Record<string, string>;
  totalFiles: number;
  indexedAt: string;
}

// ── Language-specific extractors ───────────────────────────────────────────

function extractTypeScriptSymbols(file: FetchedFile): Symbol[] {
  const symbols: Symbol[] = [];
  const lines = file.content.split('\n');

  lines.forEach((line, idx) => {
    // Exported functions
    const fn = line.match(/^export\s+(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (fn) symbols.push({ name: fn[2], kind: 'function', file: file.path, line: idx + 1 });

    // Exported classes
    const cls = line.match(/^export\s+(abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (cls) symbols.push({ name: cls[2], kind: 'class', file: file.path, line: idx + 1 });

    // Exported interfaces
    const iface = line.match(/^export\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (iface) symbols.push({ name: iface[1], kind: 'interface', file: file.path, line: idx + 1 });

    // Exported consts
    const cst = line.match(/^export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (cst) symbols.push({ name: cst[1], kind: 'const', file: file.path, line: idx + 1 });

    // Exported types
    const typ = line.match(/^export\s+type\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (typ) symbols.push({ name: typ[1], kind: 'type', file: file.path, line: idx + 1 });
  });

  return symbols;
}

function extractPythonSymbols(file: FetchedFile): Symbol[] {
  const symbols: Symbol[] = [];
  const lines = file.content.split('\n');

  lines.forEach((line, idx) => {
    const fn = line.match(/^def\s+([a-z_][a-z0-9_]*)/);
    if (fn) symbols.push({ name: fn[1], kind: 'function', file: file.path, line: idx + 1 });

    const cls = line.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (cls) symbols.push({ name: cls[1], kind: 'class', file: file.path, line: idx + 1 });
  });

  return symbols;
}

function extractJavaSymbols(file: FetchedFile): Symbol[] {
  const symbols: Symbol[] = [];
  const lines = file.content.split('\n');

  lines.forEach((line, idx) => {
    const cls = line.match(/(?:public|protected|private)?\s+(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (cls) symbols.push({ name: cls[1], kind: 'class', file: file.path, line: idx + 1 });

    const iface = line.match(/(?:public\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (iface) symbols.push({ name: iface[1], kind: 'interface', file: file.path, line: idx + 1 });
  });

  return symbols;
}

// ── Endpoint extraction ────────────────────────────────────────────────────

function extractEndpoints(files: FetchedFile[]): string[] {
  const endpoints: string[] = [];

  for (const file of files) {
    const lines = file.content.split('\n');
    for (const line of lines) {
      // Express: router.get('/path', ...)
      const express = line.match(/(?:router|app)\.(get|post|put|patch|delete|use)\(['"]([^'"]+)['"]/i);
      if (express) endpoints.push(`${express[1].toUpperCase()} ${express[2]} [${file.path}]`);

      // Django URL: path('api/...', view)
      const django = line.match(/path\(['"]([^'"]+)['"]/);
      if (django && file.path.includes('urls.py')) endpoints.push(`ROUTE ${django[1]} [${file.path}]`);

      // Spring @GetMapping / @PostMapping etc.
      const spring = line.match(/@(Get|Post|Put|Patch|Delete)Mapping\(['"]([^'"]+)['"]\)/);
      if (spring) endpoints.push(`${spring[1].toUpperCase()} ${spring[2]} [${file.path}]`);

      // Go Gin: r.GET("/path", ...)
      const gin = line.match(/\.(GET|POST|PUT|PATCH|DELETE)\(['"]([^'"]+)['"]/);
      if (gin) endpoints.push(`${gin[1]} ${gin[2]} [${file.path}]`);
    }
  }

  return [...new Set(endpoints)];
}

// ── Model extraction ────────────────────────────────────────────────────────

function extractModels(files: FetchedFile[]): string[] {
  const models: string[] = [];

  for (const file of files) {
    const content = file.content;

    // Drizzle pgTable
    for (const m of content.matchAll(/pgTable\(['"]([^'"]+)['"]/g)) {
      models.push(`${m[1]} [Drizzle, ${file.path}]`);
    }

    // Mongoose model
    for (const m of content.matchAll(/model<\w+>\(['"]([^'"]+)['"]/g)) {
      models.push(`${m[1]} [Mongoose, ${file.path}]`);
    }

    // Django Model class
    if (file.path.includes('models.py')) {
      for (const m of content.matchAll(/^class ([A-Z][A-Za-z]+)\(models\.Model\)/gm)) {
        models.push(`${m[1]} [Django, ${file.path}]`);
      }
    }

    // JPA @Entity
    if (file.path.endsWith('.java') && content.includes('@Entity')) {
      for (const m of content.matchAll(/public class ([A-Z][A-Za-z]+)/g)) {
        models.push(`${m[1]} [JPA, ${file.path}]`);
      }
    }
  }

  return [...new Set(models)];
}

// ── Import graph ───────────────────────────────────────────────────────────

function buildImportGraph(files: FetchedFile[]): Record<string, string[]> {
  const graph: Record<string, string[]> = {};

  for (const file of files) {
    const imports: string[] = [];
    for (const m of file.content.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g)) {
      imports.push(m[1]);
    }
    if (imports.length) graph[file.path] = imports;
  }

  return graph;
}

// ── File summaries ─────────────────────────────────────────────────────────

function summarizeFile(file: FetchedFile): string {
  const lines = file.content.split('\n').length;
  const symbolCount = file.content.split('\n').filter(l =>
    l.match(/^(?:export\s+)?(?:function|class|interface|const|type|def |class [A-Z])/)
  ).length;
  return `${lines} lines, ~${symbolCount} exports`;
}

// ── Detect framework ───────────────────────────────────────────────────────

function detectFramework(files: FetchedFile[]): string | undefined {
  const combined = files.slice(0, 20).map(f => f.content).join('\n').toLowerCase();
  if (combined.includes('from django')) return 'Django';
  if (combined.includes('@springbootapplication')) return 'Spring Boot';
  if (combined.includes('gin.default()') || combined.includes('package main') && combined.includes('gorm')) return 'Go + Gin';
  if (combined.includes('mongoose')) return 'MERN';
  if (combined.includes('using microsoft.aspnetcore')) return 'ASP.NET Core';
  if (combined.includes('drizzle') || combined.includes('express()')) return 'React + Express';
  return undefined;
}

// ── Main indexer ───────────────────────────────────────────────────────────

export function indexRepo(repoName: string, files: FetchedFile[]): RepoIndex {
  const allSymbols: Symbol[] = [];

  for (const file of files) {
    switch (file.language) {
      case 'typescript':
        allSymbols.push(...extractTypeScriptSymbols(file));
        break;
      case 'python':
        allSymbols.push(...extractPythonSymbols(file));
        break;
      case 'java':
        allSymbols.push(...extractJavaSymbols(file));
        break;
    }
  }

  const language = (() => {
    const counts: Record<string, number> = {};
    for (const f of files) counts[f.language] = (counts[f.language] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
  })();

  return {
    repoName,
    language,
    framework: detectFramework(files),
    symbols: allSymbols,
    endpoints: extractEndpoints(files),
    models: extractModels(files),
    importGraph: buildImportGraph(files),
    fileSummaries: Object.fromEntries(files.map(f => [f.path, summarizeFile(f)])),
    totalFiles: files.length,
    indexedAt: new Date().toISOString(),
  };
}

// ── Context builder ────────────────────────────────────────────────────────

export function buildRepoContext(index: RepoIndex, maxTokens = 1500): string {
  const parts: string[] = [
    `Repository: ${index.repoName} (${index.language}${index.framework ? ', ' + index.framework : ''})`,
    `Files indexed: ${index.totalFiles}`,
  ];

  if (index.models.length) {
    parts.push(`Data Models:\n${index.models.slice(0, 15).map(m => `  - ${m}`).join('\n')}`);
  }

  if (index.endpoints.length) {
    parts.push(`API Endpoints:\n${index.endpoints.slice(0, 20).map(e => `  - ${e}`).join('\n')}`);
  }

  const exportedFunctions = index.symbols.filter(s => s.kind === 'function').slice(0, 20);
  if (exportedFunctions.length) {
    parts.push(`Key Functions:\n${exportedFunctions.map(s => `  - ${s.name} (${s.file}:${s.line ?? '?'})`).join('\n')}`);
  }

  const result = parts.join('\n\n');
  const maxChars = maxTokens * 4;
  return result.length > maxChars ? result.slice(0, maxChars) + '...' : result;
}
