/**
 * Sandbox Dispatcher — three-tier execution routing
 *
 * Tier 1 (WebContainer) — JS/TS via @webcontainer/api (browser-side only; server uses subprocess)
 * Tier 2 (Subprocess)   — Python, Go, Ruby via child_process.spawn
 * Tier 3 (Static)       — Java, C#, .NET — structural validation without execution
 *
 * The dispatcher detects the stack from generated files and routes accordingly.
 * All tiers return a unified SandboxResult.
 */

import type { GeneratedFile } from '../pipeline-orchestrator.js';
import { runSubprocess, type SubprocessResult } from './subprocess-runner.js';
import { validateStatic, type StaticValidationResult } from './static-validator.js';

export type SandboxTier = 'subprocess' | 'static' | 'none';

export interface SandboxResult {
  tier: SandboxTier;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  errors: string[];
  warnings: string[];
  canAutoFix: boolean;
  durationMs: number;
}

export type StackId =
  | 'react-vite-express'
  | 'mern'
  | 'django-react'
  | 'spring-boot-react'
  | 'dotnet-react'
  | 'go-gin-react';

// ── Stack detection ────────────────────────────────────────────────────────

function detectStack(files: GeneratedFile[]): StackId {
  const paths = files.map(f => f.path.toLowerCase()).join('\n');
  const contents = files
    .slice(0, 10)
    .map(f => f.content.slice(0, 500))
    .join('\n')
    .toLowerCase();

  if (paths.includes('manage.py') || contents.includes('django') || contents.includes('from django')) {
    return 'django-react';
  }
  if (contents.includes('@springbootapplication') || contents.includes('spring.datasource') || paths.includes('.java')) {
    return 'spring-boot-react';
  }
  if (contents.includes('namespace') && contents.includes('using microsoft') || paths.includes('.csproj')) {
    return 'dotnet-react';
  }
  if (contents.includes('gin.default()') || contents.includes('package main') && contents.includes('gorm')) {
    return 'go-gin-react';
  }
  if (contents.includes('mongoose') || contents.includes("require('mongoose')")) {
    return 'mern';
  }
  return 'react-vite-express';
}

function getTier(stack: StackId): SandboxTier {
  switch (stack) {
    case 'django-react':
    case 'go-gin-react':
      return 'subprocess';
    case 'spring-boot-react':
    case 'dotnet-react':
    case 'react-vite-express':
    case 'mern':
      return 'static';
    default:
      return 'static';
  }
}

// ── Subprocess tier ────────────────────────────────────────────────────────

async function runSubprocessTier(
  files: GeneratedFile[],
  stack: StackId
): Promise<SandboxResult> {
  const start = Date.now();

  let result: SubprocessResult;
  switch (stack) {
    case 'django-react':
      result = await runSubprocess('python', ['-m', 'py_compile'], files, {
        fileFilter: f => f.path.endsWith('.py'),
        entryPoint: 'manage.py',
      });
      break;
    case 'go-gin-react':
      result = await runSubprocess('go', ['build', './...'], files, {
        fileFilter: f => f.path.endsWith('.go'),
        entryPoint: 'main.go',
      });
      break;
    default:
      // TS/JS — run tsc --noEmit
      result = await runSubprocess('npx', ['tsc', '--noEmit', '--strict'], files, {
        fileFilter: f => f.path.endsWith('.ts') || f.path.endsWith('.tsx'),
        entryPoint: 'tsconfig.json',
      });
  }

  const errors = extractErrors(result.stderr + result.stdout, stack);

  return {
    tier: 'subprocess',
    success: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    errors,
    warnings: extractWarnings(result.stderr),
    canAutoFix: errors.some(isAutoFixable),
    durationMs: Date.now() - start,
  };
}

// ── Static tier ────────────────────────────────────────────────────────────

async function runStaticTier(
  files: GeneratedFile[],
  stack: StackId
): Promise<SandboxResult> {
  const start = Date.now();
  const result: StaticValidationResult = await validateStatic(files, stack);
  return {
    tier: 'static',
    success: result.errors.length === 0,
    stdout: '',
    stderr: result.errors.join('\n'),
    exitCode: result.errors.length > 0 ? 1 : 0,
    errors: result.errors,
    warnings: result.warnings,
    canAutoFix: result.canAutoFix,
    durationMs: Date.now() - start,
  };
}

// ── Error parsing ──────────────────────────────────────────────────────────

function extractErrors(output: string, stack: StackId): string[] {
  const lines = output.split('\n');
  return lines.filter(l => {
    const lower = l.toLowerCase();
    if (stack === 'django-react') return lower.includes('syntaxerror') || lower.includes('importerror') || lower.includes('error:');
    if (stack === 'go-gin-react') return l.match(/\.go:\d+:\d+: /);
    // TS errors
    return l.match(/error TS\d+:/) || lower.includes(': error');
  });
}

function extractWarnings(stderr: string): string[] {
  return stderr.split('\n').filter(l => {
    const lower = l.toLowerCase();
    return lower.includes('warning') || lower.includes('deprecated');
  });
}

function isAutoFixable(error: string): boolean {
  const lower = error.toLowerCase();
  const fixable = [
    'is not used', 'implicit any', 'missing return', 'property does not exist',
    'cannot find module', "' is declared but", 'object is possibly',
    'is not assignable to type', 'missing @entity', 'missing @restcontroller',
  ];
  return fixable.some(pat => lower.includes(pat));
}

// ── Main dispatch ──────────────────────────────────────────────────────────

export async function dispatchSandbox(
  files: GeneratedFile[],
  forceStack?: StackId
): Promise<SandboxResult> {
  const stack = forceStack ?? detectStack(files);
  const tier = getTier(stack);

  console.log(`[SandboxDispatcher] Stack: ${stack}, Tier: ${tier}`);

  if (tier === 'subprocess') {
    return runSubprocessTier(files, stack);
  }

  if (tier === 'static') {
    return runStaticTier(files, stack);
  }

  return {
    tier: 'none',
    success: true,
    stdout: 'No execution sandbox for this stack combination',
    stderr: '',
    exitCode: 0,
    errors: [],
    warnings: [],
    canAutoFix: false,
    durationMs: 0,
  };
}
