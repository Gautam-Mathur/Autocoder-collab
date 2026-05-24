import type { GeneratedFile } from '../../pipeline-orchestrator.js';

const BACKEND_PATTERNS = [
  /^server\//,
  /^shared\/schema\.ts$/,
  /^shared\/db\./,
  /^drizzle\./,
  /^src\/__tests__\//,
  /^vitest\.config\./,
  /^src\/modules\//,
  /\.test\.ts$/,
  /\.spec\.ts$/,
];

const FRONTEND_CONFIG_FILES = new Set([
  'index.html',
  'package.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'vite.config.js',
  'tailwind.config.ts',
  'tailwind.config.js',
  'postcss.config.js',
  'postcss.config.cjs',
  'components.json',
  'setup.md',
  'src/index.css',
]);

export function filterFrontendFiles(baseFiles: GeneratedFile[]): GeneratedFile[] {
  return baseFiles.filter(f => {
    if (BACKEND_PATTERNS.some(p => p.test(f.path))) return false;

    if (f.path.startsWith('src/') || f.path.startsWith('client/')) return true;
    if (FRONTEND_CONFIG_FILES.has(f.path)) return true;

    return false;
  });
}
