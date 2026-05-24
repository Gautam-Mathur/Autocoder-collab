/**
 * Safety-net tests: every stack adapter must inject a runnable baseline
 * even when the LLM returns zero files.
 *
 * Locks in the fallback contract from Task #3: if anyone removes or
 * rearranges the canonical-entry-file injection, these tests fail.
 */

import { describe, it, expect } from 'vitest';
import type { ProjectPlan } from '../../src/modules/plan-generator.js';
import type { GeneratedFile } from '../../src/modules/pipeline-orchestrator.js';
import { adaptReactViteExpress } from '../../src/modules/stacks/adapters/react-vite-express.js';
import { adaptMERN } from '../../src/modules/stacks/adapters/mern.js';
import { adaptDjangoReact } from '../../src/modules/stacks/adapters/django-react.js';
import { adaptSpringBootReact } from '../../src/modules/stacks/adapters/spring-boot-react.js';
import { adaptDotNetReact } from '../../src/modules/stacks/adapters/dotnet-react.js';
import { adaptGoGinReact } from '../../src/modules/stacks/adapters/go-gin-react.js';

function makePlan(overrides: Partial<ProjectPlan> = {}): ProjectPlan {
  return {
    projectName: 'TestApp',
    overview: 'Test overview',
    techStack: [],
    modules: [],
    dataModel: [],
    pages: [],
    apiEndpoints: [],
    workflows: [],
    roles: [],
    fileBlueprint: [],
    kpis: [],
    estimatedComplexity: 'low',
    ...overrides,
  };
}

const EMPTY_BASE: GeneratedFile[] = [];

function paths(files: GeneratedFile[]): string[] {
  return files.map(f => f.path);
}

describe('stack adapter safety-net: runnable baseline with empty baseFiles', () => {
  it('react-vite-express injects index.html, main.tsx, App.tsx and warns', async () => {
    const result = await adaptReactViteExpress(makePlan(), EMPTY_BASE);
    const fp = paths(result.files);
    expect(fp).toContain('index.html');
    expect(fp).toContain('src/main.tsx');
    expect(fp).toContain('src/App.tsx');
    expect(fp).toContain('tsconfig.json');
    expect(fp).toContain('vite.config.ts');
    expect(result.warnings.some(w => /injected fallback index\.html/.test(w))).toBe(true);
    expect(result.warnings.some(w => /injected fallback main\.tsx/.test(w))).toBe(true);
    expect(result.warnings.some(w => /injected fallback App\.tsx/.test(w))).toBe(true);
  });

  it('mern injects server/index.ts, index.html, src/main.tsx, src/App.tsx and warns', async () => {
    const result = await adaptMERN(makePlan(), EMPTY_BASE);
    const fp = paths(result.files);
    expect(fp).toContain('server/index.ts');
    expect(fp).toContain('server/db/connection.ts');
    expect(fp).toContain('index.html');
    expect(fp).toContain('src/main.tsx');
    expect(fp).toContain('src/App.tsx');
    expect(result.warnings.some(w => /injected fallback server\/index\.ts/.test(w))).toBe(true);
    expect(result.warnings.some(w => /injected fallback index\.html/.test(w))).toBe(true);
    expect(result.warnings.some(w => /injected fallback src\/main\.tsx/.test(w))).toBe(true);
    expect(result.warnings.some(w => /injected fallback src\/App\.tsx/.test(w))).toBe(true);
  });

  it('django-react injects manage.py, settings.py, wsgi.py, urls.py and warns', async () => {
    const result = await adaptDjangoReact(makePlan({ projectName: 'TestApp' }), EMPTY_BASE);
    const fp = paths(result.files);
    expect(fp).toContain('manage.py');
    expect(fp).toContain('testapp/settings.py');
    expect(fp).toContain('testapp/urls.py');
    expect(fp).toContain('testapp/wsgi.py');
    expect(fp).toContain('testapp/asgi.py');
    expect(fp).toContain('testapp/__init__.py');
    expect(fp).toContain('api/__init__.py');
    expect(fp).toContain('api/apps.py');
    expect(fp).toContain('api/views.py');
    expect(fp).toContain('api/urls.py');
    expect(fp).toContain('requirements.txt');
    expect(result.warnings.some(w => /injected baseline manage\.py/.test(w))).toBe(true);
    expect(result.warnings.some(w => /injected baseline testapp\/settings\.py/.test(w))).toBe(true);
    expect(result.warnings.some(w => /injected baseline testapp\/urls\.py/.test(w))).toBe(true);
    expect(result.warnings.some(w => /health-only baseline serializers/.test(w))).toBe(true);
  });

  it('spring-boot-react injects pom.xml, application.properties, main Application class and warns', async () => {
    const result = await adaptSpringBootReact(makePlan({ projectName: 'TestApp' }), EMPTY_BASE);
    const fp = paths(result.files);
    expect(fp).toContain('pom.xml');
    expect(fp).toContain('src/main/resources/application.properties');
    const appJava = fp.find(p => /^src\/main\/java\/com\/app\/testapp\/.*Application\.java$/.test(p));
    expect(appJava).toBeTruthy();
    expect(result.warnings.some(w => /injected baseline .*Application\.java entry/.test(w))).toBe(true);
  });

  it('dotnet-react injects .csproj, Program.cs, AppDbContext, HealthController and warns', async () => {
    const result = await adaptDotNetReact(makePlan({ projectName: 'TestApp' }), EMPTY_BASE);
    const fp = paths(result.files);
    expect(fp).toContain('Program.cs');
    expect(fp).toContain('TestApp.csproj');
    expect(fp).toContain('appsettings.json');
    expect(fp).toContain('Data/AppDbContext.cs');
    expect(fp).toContain('Controllers/HealthController.cs');
    expect(result.warnings.some(w => /injected baseline Program\.cs entry/.test(w))).toBe(true);
    expect(result.warnings.some(w => /health-only baseline controller/.test(w))).toBe(true);
  });

  it('go-gin-react injects go.mod, main.go and warns', async () => {
    const result = await adaptGoGinReact(makePlan({ projectName: 'TestApp' }), EMPTY_BASE);
    const fp = paths(result.files);
    expect(fp).toContain('go.mod');
    expect(fp).toContain('main.go');
    expect(result.warnings.some(w => /health-only baseline main\.go/.test(w))).toBe(true);
  });
});
