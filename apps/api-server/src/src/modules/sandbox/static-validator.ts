/**
 * Static Validator — structural validation for Java/Spring and C#/.NET projects
 *
 * Runs WITHOUT execution — performs AST-level regex checks to catch:
 *   - Missing @RestController / @Entity annotations (Spring)
 *   - Missing DbContext / controller base class (ASP.NET)
 *   - Mismatched method signatures
 *   - Missing required files (pom.xml / *.csproj)
 */

import type { GeneratedFile } from '../pipeline-orchestrator.js';
import type { StackId } from './sandbox-dispatcher.js';

export interface StaticValidationResult {
  errors: string[];
  warnings: string[];
  canAutoFix: boolean;
}

// ── Java/Spring checks ─────────────────────────────────────────────────────

function validateSpring(files: GeneratedFile[]): StaticValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const javaFiles = files.filter(f => f.path.endsWith('.java'));
  const hasPom = files.some(f => f.path === 'pom.xml' || f.path.endsWith('/pom.xml'));

  if (!hasPom) errors.push('Missing pom.xml — Spring Boot project requires Maven build file');

  const mainApp = javaFiles.find(f => f.content.includes('@SpringBootApplication'));
  if (!mainApp) errors.push('Missing @SpringBootApplication entry point class');

  for (const f of javaFiles) {
    if (f.path.includes('/controller/') || f.path.includes('Controller.java')) {
      if (!f.content.includes('@RestController') && !f.content.includes('@Controller')) {
        errors.push(`${f.path}: Controller class missing @RestController or @Controller annotation`);
      }
      if (!f.content.includes('@RequestMapping') && !f.content.includes('@GetMapping') && !f.content.includes('@PostMapping')) {
        warnings.push(`${f.path}: Controller has no request mapping annotations`);
      }
    }

    const isEntityCandidate = f.path.includes('/entity/') || f.path.includes('/model/') || f.path.includes('/models/')
      || f.path.includes('Entity.java') || f.path.includes('Model.java')
      || (f.content.includes('private Long id') || f.content.includes('private Integer id'));
    if (isEntityCandidate) {
      if (!f.content.includes('@Entity')) {
        errors.push(`${f.path}: Entity class missing @Entity annotation`);
      }
      if (!f.content.includes('@Id')) {
        warnings.push(`${f.path}: Entity class missing @Id field`);
      }
    }

    if (f.path.includes('/repository/') || f.path.includes('Repository.java')) {
      if (!f.content.includes('extends JpaRepository') && !f.content.includes('extends CrudRepository')) {
        warnings.push(`${f.path}: Repository should extend JpaRepository or CrudRepository`);
      }
    }
  }

  return { errors, warnings, canAutoFix: errors.some(e => e.includes('annotation')) };
}

// ── C#/.NET checks ────────────────────────────────────────────────────────

function validateDotNet(files: GeneratedFile[]): StaticValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const csFiles = files.filter(f => f.path.endsWith('.cs'));
  const hasCsproj = files.some(f => f.path.endsWith('.csproj'));

  if (!hasCsproj) errors.push('Missing .csproj file — ASP.NET project requires a project file');

  const hasProgram = csFiles.some(f => f.content.includes('WebApplication.CreateBuilder') || f.content.includes('class Program'));
  if (!hasProgram) errors.push('Missing Program.cs with WebApplication.CreateBuilder');

  for (const f of csFiles) {
    if (f.path.includes('Controller') || f.path.includes('/Controllers/')) {
      if (!f.content.includes('[ApiController]') && !f.content.includes(': ControllerBase')) {
        errors.push(`${f.path}: Controller missing [ApiController] attribute or ControllerBase base class`);
      }
      if (!f.content.includes('[Route(')) {
        warnings.push(`${f.path}: Controller missing [Route] attribute`);
      }
    }

    if (f.path.includes('DbContext') || f.path.includes('Context.cs')) {
      if (!f.content.includes(': DbContext')) {
        errors.push(`${f.path}: DbContext class must extend Microsoft.EntityFrameworkCore.DbContext`);
      }
    }
  }

  return { errors, warnings, canAutoFix: warnings.length > 0 };
}

// ── TS/JS structural checks ──────────────────────────────────────────────

function validateTypeScript(files: GeneratedFile[]): StaticValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const tsFiles = files.filter(f => f.path.endsWith('.ts') || f.path.endsWith('.tsx'));
  const jsFiles = files.filter(f => f.path.endsWith('.js') || f.path.endsWith('.jsx'));
  const allCodeFiles = [...tsFiles, ...jsFiles];
  const hasPackageJson = files.some(f => f.path === 'package.json' || f.path.endsWith('/package.json'));

  if (!hasPackageJson) {
    errors.push('Missing package.json — project requires a package manifest');
  }

  if (allCodeFiles.length === 0) {
    errors.push('No TypeScript or JavaScript source files found');
  }

  const hasEntryFile = files.some(f =>
    f.path === 'src/index.ts' || f.path === 'src/index.tsx' ||
    f.path === 'src/main.ts' || f.path === 'src/main.tsx' ||
    f.path === 'src/App.tsx' || f.path === 'src/App.jsx' ||
    f.path === 'index.ts' || f.path === 'index.tsx' ||
    f.path === 'server/index.ts' || f.path === 'server.ts' ||
    f.path === 'index.html'
  );
  if (!hasEntryFile && allCodeFiles.length > 0) {
    warnings.push('No recognizable entry file found (index.ts, main.tsx, App.tsx, etc.)');
  }

  for (const f of allCodeFiles) {
    const content = f.content;
    const openBraces = (content.match(/\{/g) || []).length;
    const closeBraces = (content.match(/\}/g) || []).length;
    if (Math.abs(openBraces - closeBraces) > 2) {
      errors.push(`${f.path}: Mismatched braces (${openBraces} open, ${closeBraces} close) — likely syntax error`);
    }

    const openParens = (content.match(/\(/g) || []).length;
    const closeParens = (content.match(/\)/g) || []).length;
    if (Math.abs(openParens - closeParens) > 2) {
      errors.push(`${f.path}: Mismatched parentheses (${openParens} open, ${closeParens} close) — likely syntax error`);
    }

    if (content.includes('TODO: implement') || content.includes('throw new Error("Not implemented")')) {
      warnings.push(`${f.path}: Contains unimplemented stubs`);
    }
  }

  for (const f of allCodeFiles) {
    if (f.content.includes('export default') || f.content.includes('export {') || f.content.includes('export function') || f.content.includes('export const') || f.content.includes('export class') || f.content.includes('export interface') || f.content.includes('export type')) {
      continue;
    }
    if (f.path.includes('/components/') || f.path.includes('/pages/') || f.path.includes('/hooks/')) {
      warnings.push(`${f.path}: No exports found — component files typically export at least one symbol`);
    }
  }

  const routeFiles = allCodeFiles.filter(f => f.path.includes('route') || f.path.includes('Route') || f.path.includes('router'));
  for (const f of routeFiles) {
    if (!f.content.includes('app.') && !f.content.includes('router.') && !f.content.includes('Router') && !f.content.includes('Route')) {
      warnings.push(`${f.path}: Route file has no route definitions`);
    }
  }

  return { errors, warnings, canAutoFix: errors.some(e => e.includes('syntax error')) };
}

// ── Dispatch ───────────────────────────────────────────────────────────────

export async function validateStatic(
  files: GeneratedFile[],
  stack: StackId
): Promise<StaticValidationResult> {
  switch (stack) {
    case 'spring-boot-react':
      return validateSpring(files);
    case 'dotnet-react':
      return validateDotNet(files);
    case 'react-vite-express':
    case 'mern':
      return validateTypeScript(files);
    default:
      return { errors: [], warnings: [], canAutoFix: false };
  }
}
