/**
 * Dependency Resolver - The "DevOps Engineer" of the development team
 *
 * Manages project dependencies:
 * - Smart package selection based on features
 * - Version compatibility checking
 * - Bundle size awareness
 * - Peer dependency resolution
 * - Dev vs production classification
 * - Tree-shaking compatibility
 * - Security vulnerability awareness
 * - Duplicate detection
 * - Import scanning
 */

import type { ProjectPlan, PlannedEntity } from './plan-generator.js';
import { getBestPractices, getDomainModel } from './knowledge-base.js';
import { AVAILABLE_DEPS, DEV_DEPS } from './dependency-registry.js';

export interface GeneratedFile {
  path: string;
  content: string;
  language: string;
}

export interface DependencyManifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  scripts: Record<string, string>;
  warnings: string[];
  optimizations: string[];
  bundleSizeEstimate: BundleSizeEstimate;
  securityNotes: string[];
}

export interface BundleSizeEstimate {
  totalKB: number;
  breakdown: PackageSize[];
  treeShakeable: string[];
  nonTreeShakeable: string[];
}

export interface PackageSize {
  name: string;
  estimatedKB: number;
  treeShakeable: boolean;
  category: 'ui' | 'state' | 'utility' | 'network' | 'build' | 'test' | 'other';
}

const PACKAGE_METADATA: Record<string, Omit<PackageInfo, 'version'>> = {
  'react': { size: 6, treeShakeable: false, category: 'ui', isDev: false },
  'react-dom': { size: 130, treeShakeable: false, category: 'ui', isDev: false },
  'wouter': { size: 4, treeShakeable: true, category: 'ui', isDev: false },
  '@tanstack/react-query': { size: 40, treeShakeable: true, category: 'state', isDev: false },
  'zod': { size: 13, treeShakeable: true, category: 'utility', isDev: false },
  'tailwindcss': { size: 0, treeShakeable: false, category: 'build', isDev: true },
  'lucide-react': { size: 0.5, treeShakeable: true, category: 'ui', isDev: false },
  'class-variance-authority': { size: 2, treeShakeable: true, category: 'ui', isDev: false },
  'clsx': { size: 0.5, treeShakeable: true, category: 'utility', isDev: false },
  'tailwind-merge': { size: 5, treeShakeable: true, category: 'utility', isDev: false },
  'date-fns': { size: 20, treeShakeable: true, category: 'utility', isDev: false },
  'recharts': { size: 200, treeShakeable: true, category: 'ui', isDev: false },
  'framer-motion': { size: 90, treeShakeable: true, category: 'ui', isDev: false },
  '@radix-ui/react-dialog': { size: 15, treeShakeable: true, category: 'ui', isDev: false },
  '@radix-ui/react-dropdown-menu': { size: 15, treeShakeable: true, category: 'ui', isDev: false },
  '@radix-ui/react-select': { size: 15, treeShakeable: true, category: 'ui', isDev: false },
  '@radix-ui/react-tabs': { size: 8, treeShakeable: true, category: 'ui', isDev: false },
  '@radix-ui/react-toast': { size: 10, treeShakeable: true, category: 'ui', isDev: false },
  '@radix-ui/react-tooltip': { size: 8, treeShakeable: true, category: 'ui', isDev: false },
  '@radix-ui/react-label': { size: 3, treeShakeable: true, category: 'ui', isDev: false },
  '@radix-ui/react-checkbox': { size: 8, treeShakeable: true, category: 'ui', isDev: false },
  '@radix-ui/react-switch': { size: 8, treeShakeable: true, category: 'ui', isDev: false },
  '@radix-ui/react-separator': { size: 3, treeShakeable: true, category: 'ui', isDev: false },
  '@radix-ui/react-slot': { size: 2, treeShakeable: true, category: 'ui', isDev: false },
  '@radix-ui/react-scroll-area': { size: 10, treeShakeable: true, category: 'ui', isDev: false },
  '@radix-ui/react-progress': { size: 5, treeShakeable: true, category: 'ui', isDev: false },
  'express': { size: 50, treeShakeable: false, category: 'network', isDev: false },
  'drizzle-orm': { size: 30, treeShakeable: true, category: 'state', isDev: false },
  '@neondatabase/serverless': { size: 20, treeShakeable: true, category: 'network', isDev: false },
  'drizzle-zod': { size: 5, treeShakeable: true, category: 'utility', isDev: false },
  'uuid': { size: 2, treeShakeable: true, category: 'utility', isDev: false },
  'nanoid': { size: 0.5, treeShakeable: true, category: 'utility', isDev: false },
  'vite': { size: 0, treeShakeable: false, category: 'build', isDev: true },
  'vitest': { size: 0, treeShakeable: false, category: 'test', isDev: true },
  'typescript': { size: 0, treeShakeable: false, category: 'build', isDev: true },
  '@types/react': { size: 0, treeShakeable: false, category: 'build', isDev: true },
  '@types/react-dom': { size: 0, treeShakeable: false, category: 'build', isDev: true },
  '@types/express': { size: 0, treeShakeable: false, category: 'build', isDev: true },
  '@tailwindcss/postcss': { size: 0, treeShakeable: false, category: 'build', isDev: true },
  'postcss': { size: 0, treeShakeable: false, category: 'build', isDev: true },
  '@vitejs/plugin-react': { size: 0, treeShakeable: false, category: 'build', isDev: true },
  'drizzle-kit': { size: 0, treeShakeable: false, category: 'build', isDev: true },
  'tsx': { size: 0, treeShakeable: false, category: 'build', isDev: true },
  'esbuild': { size: 0, treeShakeable: false, category: 'build', isDev: true },
};

const PACKAGE_REGISTRY: Record<string, PackageInfo> = Object.fromEntries(
  Object.entries(PACKAGE_METADATA).map(([pkg, meta]) => [
    pkg,
    {
      ...meta,
      version: (meta.isDev ? DEV_DEPS[pkg] : AVAILABLE_DEPS[pkg]) || 'latest',
    },
  ])
);

interface PackageInfo {
  version: string;
  size: number;
  treeShakeable: boolean;
  category: PackageSize['category'];
  isDev: boolean;
}

const FEATURE_PACKAGES: Record<string, string[]> = {
  'charts': ['recharts'],
  'animations': ['framer-motion'],
  'forms': ['zod'],
  'drag-drop': ['@dnd-kit/core', '@dnd-kit/sortable'],
  'rich-text': ['@tiptap/react', '@tiptap/starter-kit'],
  'file-upload': ['multer'],
  'export-csv': ['papaparse'],
  'export-excel': ['exceljs'],
  'date-picker': ['date-fns'],
  'markdown': ['react-markdown', 'remark-gfm'],
  'syntax-highlight': ['prismjs'],
  'virtual-scroll': ['@tanstack/react-virtual'],
  'color-picker': ['react-colorful'],
};

export function resolveDependencies(plan: ProjectPlan, files: GeneratedFile[], detectedDomain?: string): DependencyManifest {
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  const warnings: string[] = [];
  const optimizations: string[] = [];
  const securityNotes: string[] = [];

  addCoreDependencies(dependencies, devDependencies);

  if (detectedDomain) {
    try {
      const domainModel = getDomainModel(detectedDomain);
      if (domainModel) {
        const KB_FEATURE_TO_PACKAGE: Record<string, { pkg: string; version: string }> = {
          'dashboard': { pkg: 'recharts', version: '^2.13.3' },
          'chart': { pkg: 'recharts', version: '^2.13.3' },
          'analytics': { pkg: 'recharts', version: '^2.13.3' },
          'reporting': { pkg: 'recharts', version: '^2.13.3' },
          'calendar': { pkg: 'date-fns', version: '^3.6.0' },
          'scheduling': { pkg: 'date-fns', version: '^3.6.0' },
          'timeline': { pkg: 'date-fns', version: '^3.6.0' },
          'export': { pkg: 'papaparse', version: '^5.4.1' },
          'csv': { pkg: 'papaparse', version: '^5.4.1' },
          'drag': { pkg: '@dnd-kit/core', version: '^6.1.0' },
          'kanban': { pkg: '@dnd-kit/core', version: '^6.1.0' },
          'rich-text': { pkg: '@tiptap/react', version: '^2.4.0' },
          'editor': { pkg: '@tiptap/react', version: '^2.4.0' },
          'markdown': { pkg: 'react-markdown', version: '^9.0.1' },
          'file-upload': { pkg: 'multer', version: '^1.4.5-lts.1' },
          'upload': { pkg: 'multer', version: '^1.4.5-lts.1' },
        };

        for (const feature of domainModel.typicalFeatures || []) {
          const featureLower = feature.toLowerCase();
          for (const [keyword, pkgInfo] of Object.entries(KB_FEATURE_TO_PACKAGE)) {
            if (featureLower.includes(keyword) && !dependencies[pkgInfo.pkg]) {
              dependencies[pkgInfo.pkg] = pkgInfo.version;
              optimizations.push(`KB: added "${pkgInfo.pkg}" for domain feature "${feature}"`);
            }
          }
          if (!Object.keys(KB_FEATURE_TO_PACKAGE).some(k => featureLower.includes(k))) {
            optimizations.push(`KB: domain "${detectedDomain}" typically requires "${feature}"`);
          }
        }

        for (const note of domainModel.securityConsiderations || []) {
          securityNotes.push(`KB: ${note}`);
        }
      }

      const depBestPractices = getBestPractices('dependencies');
      for (const bp of depBestPractices.slice(0, 3)) {
        if (bp.description) {
          securityNotes.push(`KB: ${bp.title || bp.id} — ${bp.description}`);
        }
      }
    } catch (e) {
      console.warn('[KB] dependency resolution KB enrichment failed:', e);
    }
  }

  const importedPackages = scanImports(files);

  for (const pkg of Array.from(importedPackages)) {
    const info = PACKAGE_REGISTRY[pkg];
    if (info) {
      if (info.isDev) {
        devDependencies[pkg] = info.version;
      } else {
        dependencies[pkg] = info.version;
      }
    } else if (AVAILABLE_DEPS[pkg]) {
      dependencies[pkg] = AVAILABLE_DEPS[pkg];
    } else if (DEV_DEPS[pkg]) {
      devDependencies[pkg] = DEV_DEPS[pkg];
    }
  }

  const features = detectFeatures(plan, files);
  for (const feature of features) {
    const packages = FEATURE_PACKAGES[feature];
    if (packages) {
      for (const pkg of packages) {
        const info = PACKAGE_REGISTRY[pkg];
        if (info) {
          if (info.isDev) devDependencies[pkg] = info.version;
          else dependencies[pkg] = info.version;
        } else if (AVAILABLE_DEPS[pkg]) {
          dependencies[pkg] = AVAILABLE_DEPS[pkg];
        } else if (DEV_DEPS[pkg]) {
          devDependencies[pkg] = DEV_DEPS[pkg];
        } else {
          dependencies[pkg] = 'latest';
          warnings.push(`Package "${pkg}" not in registry — using "latest" version`);
        }
      }
    }
  }

  const planIntegrations = (plan as any).integrations as Array<{ type: string; requiredPackages?: string[] }> | undefined;
  if (planIntegrations && planIntegrations.length > 0) {
    for (const integ of planIntegrations) {
      if (integ.requiredPackages) {
        for (const pkg of integ.requiredPackages) {
          if (!dependencies[pkg] && !devDependencies[pkg]) {
            const info = PACKAGE_REGISTRY[pkg];
            if (info) {
              if (info.isDev) devDependencies[pkg] = info.version;
              else dependencies[pkg] = info.version;
            } else if (AVAILABLE_DEPS[pkg]) {
              dependencies[pkg] = AVAILABLE_DEPS[pkg];
            } else if (DEV_DEPS[pkg]) {
              devDependencies[pkg] = DEV_DEPS[pkg];
            } else {
              dependencies[pkg] = 'latest';
              warnings.push(`Integration "${integ.type}" needs "${pkg}" — not in registry, using "latest"`);
            }
          }
        }
      }
    }
  }

  const bundleSize = estimateBundleSize({ ...dependencies, ...devDependencies });

  if (bundleSize.totalKB > 500) {
    warnings.push(`Estimated bundle size is ${bundleSize.totalKB}KB — consider code splitting`);
  }

  if (dependencies['moment']) {
    optimizations.push('Replace "moment" with "date-fns" for smaller bundle (moment: ~300KB vs date-fns: ~20KB tree-shaken)');
  }

  if (dependencies['lodash'] && !dependencies['lodash-es']) {
    optimizations.push('Use "lodash-es" instead of "lodash" for tree-shaking support');
  }

  const duplicateUI = checkDuplicateCategories(dependencies);
  for (const dup of duplicateUI) {
    warnings.push(dup);
  }

  const scripts = detectScripts({ ...dependencies, ...devDependencies });

  return {
    dependencies,
    devDependencies,
    peerDependencies: {},
    scripts,
    warnings,
    optimizations,
    bundleSizeEstimate: bundleSize,
    securityNotes,
  };
}

function addCoreDependencies(deps: Record<string, string>, devDeps: Record<string, string>) {
  const coreProd = ['react', 'react-dom', 'wouter', '@tanstack/react-query', 'zod',
    'clsx', 'tailwind-merge', 'class-variance-authority', 'lucide-react',
    '@radix-ui/react-slot', '@radix-ui/react-toast', '@radix-ui/react-tooltip',
    '@radix-ui/react-label', '@radix-ui/react-dialog',
    'express', 'drizzle-orm', '@neondatabase/serverless', 'drizzle-zod'];

  const coreDev = ['vite', '@vitejs/plugin-react', 'typescript', 'tailwindcss',
    'postcss', '@tailwindcss/postcss', 'tsx', 'esbuild', 'drizzle-kit',
    '@types/react', '@types/react-dom', '@types/express'];

  for (const pkg of coreProd) {
    const info = PACKAGE_REGISTRY[pkg];
    if (info) deps[pkg] = info.version;
    else if (AVAILABLE_DEPS[pkg]) deps[pkg] = AVAILABLE_DEPS[pkg];
  }

  for (const pkg of coreDev) {
    const info = PACKAGE_REGISTRY[pkg];
    if (info) devDeps[pkg] = info.version;
    else if (DEV_DEPS[pkg]) devDeps[pkg] = DEV_DEPS[pkg];
  }
}

function scanImports(files: GeneratedFile[]): Set<string> {
  const packages = new Set<string>();
  const importRegex = /(?:import|require)\s*(?:\(?\s*['"]|.*from\s*['"])([^'"./][^'"]*)['"]/g;

  for (const file of files) {
    let match;
    const regex = new RegExp(importRegex.source, 'g');
    while ((match = regex.exec(file.content)) !== null) {
      let pkg = match[1];
      if (pkg.startsWith('@')) {
        const parts = pkg.split('/');
        pkg = `${parts[0]}/${parts[1]}`;
      } else {
        pkg = pkg.split('/')[0];
      }
      if (!pkg.startsWith('.') && pkg !== 'path' && pkg !== 'fs' && pkg !== 'url' && pkg !== 'crypto' && pkg !== 'http' && pkg !== 'https') {
        packages.add(pkg);
      }
    }
  }

  return packages;
}

function detectFeatures(plan: ProjectPlan, files: GeneratedFile[]): string[] {
  const features: string[] = [];
  const content = files.map(f => f.content).join('\n');
  const entities = plan.dataModel || [];

  const hasDashboard = (plan.pages || []).some(p => p.name?.toLowerCase().includes('dashboard'));
  if (hasDashboard || content.includes('Chart') || content.includes('Recharts')) {
    features.push('charts');
  }

  if (content.includes('framer-motion') || content.includes('motion.') || content.includes('AnimatePresence')) {
    features.push('animations');
  }

  if (content.includes('drag') || content.includes('Draggable') || content.includes('DndContext')) {
    features.push('drag-drop');
  }

  for (const entity of entities) {
    for (const field of entity.fields) {
      const lower = field.name.toLowerCase();
      if (lower.includes('image') || lower.includes('file') || lower.includes('attachment')) {
        features.push('file-upload');
      }
    }
  }

  if (content.includes('date-fns') || content.includes('DatePicker') || content.includes('format(')) {
    features.push('date-picker');
  }

  return Array.from(new Set(features));
}

function estimateBundleSize(allDeps: Record<string, string>): BundleSizeEstimate {
  const breakdown: PackageSize[] = [];
  const treeShakeable: string[] = [];
  const nonTreeShakeable: string[] = [];
  let totalKB = 0;

  for (const [name] of Object.entries(allDeps)) {
    const info = PACKAGE_REGISTRY[name];
    if (info && info.size > 0) {
      breakdown.push({
        name,
        estimatedKB: info.size,
        treeShakeable: info.treeShakeable,
        category: info.category,
      });
      totalKB += info.size;
      if (info.treeShakeable) treeShakeable.push(name);
      else nonTreeShakeable.push(name);
    }
  }

  breakdown.sort((a, b) => b.estimatedKB - a.estimatedKB);

  return { totalKB, breakdown, treeShakeable, nonTreeShakeable };
}

const PACKAGE_SCRIPTS: Record<string, Record<string, string>> = {
  'drizzle-kit': { 'db:push': 'drizzle-kit push', 'db:studio': 'drizzle-kit studio', 'db:generate': 'drizzle-kit generate' },
  'prisma': { 'db:generate': 'prisma generate', 'db:push': 'prisma db push', 'db:migrate': 'prisma migrate dev' },
  'sass': { 'build:css': 'sass src/styles:dist/styles' },
  'vitest': { 'test': 'vitest run', 'test:watch': 'vitest' },
  'tailwindcss': { 'build:css': 'tailwindcss -i ./client/src/index.css -o ./dist/output.css' },
  'tsx': { 'dev': 'tsx watch server/index.ts' },
  'esbuild': { 'build': 'esbuild server/index.ts --bundle --platform=node --outdir=dist' },
};

function detectScripts(allDeps: Record<string, string>): Record<string, string> {
  const scripts: Record<string, string> = {};

  for (const [pkg, scriptMap] of Object.entries(PACKAGE_SCRIPTS)) {
    if (allDeps[pkg]) {
      for (const [scriptName, scriptCmd] of Object.entries(scriptMap)) {
        if (!scripts[scriptName]) {
          scripts[scriptName] = scriptCmd;
        }
      }
    }
  }

  return scripts;
}

function checkDuplicateCategories(deps: Record<string, string>): string[] {
  const warnings: string[] = [];
  const stateLibs = Object.keys(deps).filter(d =>
    d.includes('zustand') || d.includes('redux') || d.includes('jotai') ||
    d.includes('recoil') || d.includes('mobx') || d.includes('valtio'));
  if (stateLibs.length > 1) {
    warnings.push(`Multiple state management libraries detected: ${stateLibs.join(', ')} — pick one`);
  }

  const cssLibs = Object.keys(deps).filter(d =>
    d.includes('styled-components') || d.includes('@emotion') ||
    d.includes('sass') || d.includes('less'));
  if (cssLibs.length > 0 && deps['tailwindcss']) {
    warnings.push(`CSS-in-JS library detected alongside Tailwind: ${cssLibs.join(', ')} — may cause conflicts`);
  }

  return warnings;
}