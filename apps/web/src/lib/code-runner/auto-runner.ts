// Auto-Runner Pipeline - Generate → Install → Run → Preview
// Seamlessly runs generated projects without manual intervention

import {
  getWebContainer,
  mountFiles,
  tryRemoveFile,
  writeFile,
  readFile,
  installDependencies,
  runNpmInstall,
  startDevServer,
  killDevServer,
  isWebContainerSupported,
  hasNodeModules,
  setPackageJsonHash,
  getPreWarmStatus,
  getPreWarmedPackages,
  awaitPreWarm,
  fixBinPermissions,
  triggerSnapshotBuild,
  onPreWarmProgress,
  type FileSystemTree,
  type RunResult
} from './webcontainer';
import { runnerLog } from './logger';
import { autoFixEngine, drainKnownTypos, auditResidualBrokenPatterns, runVerifyThenStartGate, type AutoFixContext, type ResidualFinding } from './auto-fix-engine';
import { classifyFileCriticality } from './file-criticality';
import { generateStub } from './template-basement';
import { runViteTailwindDoctor, stripAnsi as stripDoctorAnsi } from './vite-tailwind-doctor';
import { runThreeLayerCascade } from './three-layer-cascade';

export function sanitizeLLMOutput(files: { path: string; content: string }[]): { path: string; content: string }[] {
  const codeExts = /\.(tsx?|jsx?|mjs|cjs)$/;
  return files.map(f => {
    if (!codeExts.test(f.path)) return f;
    let c = f.content;

    c = c.replace(/\(\s*\)\s*=\)/g, '() =>');
    c = c.replace(/\(([^)]+)\)\s*=\)/g, '($1) =>');

    c = c.replace(/=\)\s*\{/g, '=> {');
    c = c.replace(/=\)\s*\(/g, '=> (');

    c = c.replace(/=\)\s*$/gm, '=>');
    c = c.replace(/=\)\s*;/g, '=>;');

    // Mangled JSX arrow `(e) = />` → `(e) =>`. Babel reports
    // "Unterminated regular expression" because `/>` looks like a regex.
    // Guarded: must follow a paren-close (signature of arrow params) so
    // we don't touch legitimate `prop = />` (which would be invalid JSX
    // anyway, but stay conservative).
    c = c.replace(/(\))(\s*)=(\s*)\/>(\s*)/g, '$1$2=>$4');

    // Hook with elided body and stray ")" instead of array close:
    // `useMemo(() => [)` → `useMemo(() => [], [])`. Sanitize-time fix
    // so the file mounts parseable; the drain rule covers any sites the
    // sanitizer's regex misses.
    c = c.replace(
      /(useMemo|useCallback|useEffect)\(\s*((?:async\s*)?)\(\s*\)\s*=>\s*\[\)/g,
      (_m, h, a) => `${h}(${a}() => [], [])`,
    );

    // defineConfig() { → defineConfig({ is now handled by vite-tailwind-doctor.ts

    {
      const cLines = c.split('\n');
      let fixedParen = false;
      for (let li = 0; li < cLines.length; li++) {
        const line = cLines[li];
        if (/^\s*import\s/.test(line) || /^\s*\/\//.test(line) || /^\s*\*/.test(line) || /^\s*\/\*/.test(line)) continue;
        if (/\/[^/\s*][^/]*\/[gimsuy]*/.test(line)) continue;
        if (/\.(replace|match|test|search|split)\s*\(/.test(line)) continue;
        let depth = 0;
        let inStr: string | null = null;
        let escaped = false;
        for (let ci = 0; ci < line.length; ci++) {
          const ch = line[ci];
          if (escaped) { escaped = false; continue; }
          if (ch === '\\') { escaped = true; continue; }
          if (inStr) {
            if (ch === inStr) inStr = null;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
        }
        if (depth === 1) {
          const arrowMissing = line.match(/^(\s*(?:const|let|var|function)?\s*\w+\s*=\s*\([^)]*)\s*(=>)/);
          if (arrowMissing) {
            cLines[li] = line.replace(/(\([^)]*)\s*(=>)/, '$1) $2');
            fixedParen = true;
          } else {
            const trimmed = line.trimEnd();
            if (trimmed.endsWith('{')) {
              // Guard: if the `{` is the body opener of an arrow function
              // (`=> {` possibly with a return-type annotation between),
              // the arrow LEGITIMATELY consumes one paren-depth — appending
              // `)` here would corrupt valid code into `=> ) {`. The
              // unclosed-paren is somewhere upstream (multi-line call args)
              // and is NOT this file's problem to fix here.
              const arrowBody = /=>\s*(?::\s*[^=]+?\s*)?\{\s*$/.test(trimmed);
              if (arrowBody) {
                // Skip — leave the line alone.
              } else {
                cLines[li] = line.replace(/\{\s*$/, ') {');
                fixedParen = true;
              }
            } else if (trimmed.endsWith('=>')) {
              cLines[li] = line.replace(/=>\s*$/, ') =>');
              fixedParen = true;
            } else if (trimmed.endsWith(',')) {
              cLines[li] = line.replace(/,\s*$/, '),');
              fixedParen = true;
            } else if (!trimmed.endsWith('(') && !trimmed.endsWith('/**') && !trimmed.endsWith('/*')) {
              cLines[li] = line.trimEnd() + ')';
              fixedParen = true;
            }
          }
        }
      }
      if (fixedParen) {
        c = cLines.join('\n');
      }
    }

    const seenLines = new Set<string>();
    const declaredBindings = new Set<string>();
    const lines = c.split('\n');
    const cleaned: string[] = [];
    let changed = false;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const m = line.match(/^\s*import\s+(.+)\s+from\s+["']([^"']+)["']\s*;?\s*$/);
      if (m) {
        const normKey = m[0].replace(/\s+/g, ' ').trim();
        if (seenLines.has(normKey)) {
          changed = true;
          continue;
        }
        seenLines.add(normKey);

        const namedMatch = line.match(/\{\s*([^}]+)\s*\}/);
        const namedBindings: string[] = [];
        if (namedMatch) {
          namedMatch[1].split(',').forEach(b => {
            const name = b.trim().split(/\s+as\s+/).pop()!.trim();
            if (name) namedBindings.push(name);
          });
        }
        const defaultMatch = line.match(/import\s+(\w+)[\s,]/);
        const defaultBinding = (defaultMatch && defaultMatch[1] !== 'type') ? defaultMatch[1] : null;

        const allBindings = [...namedBindings];
        if (defaultBinding) allBindings.push(defaultBinding);

        const dupeBindings = allBindings.filter(b => declaredBindings.has(b));
        if (dupeBindings.length > 0) {
          const newNamedBindings = namedBindings.filter(b => !declaredBindings.has(b));
          const keepDefault = defaultBinding && !declaredBindings.has(defaultBinding);
          if (newNamedBindings.length === 0 && !keepDefault) {
            changed = true;
            continue;
          }
          if (dupeBindings.length > 0 && namedMatch) {
            const sourceMatch = line.match(/from\s+(["'][^"']+["'])/);
            const semi = line.trimEnd().endsWith(';') ? ';' : '';
            const indent = line.match(/^(\s*)/)?.[1] || '';
            const parts: string[] = [];
            if (keepDefault) parts.push(defaultBinding!);
            if (newNamedBindings.length > 0) parts.push(`{ ${newNamedBindings.join(', ')} }`);
            if (sourceMatch && parts.length > 0) {
              lines[li] = `${indent}import ${parts.join(', ')} from ${sourceMatch[1]}${semi}`;
              changed = true;
            }
          }
        }
        allBindings.forEach(b => declaredBindings.add(b));
      }
      cleaned.push(lines[li]);
    }
    if (changed) c = cleaned.join('\n');

    // Pre-mount drain — catches the high-confidence LLM typo set
    // (mangled-arrow `(e) = />`, call-options-block, duplicated-paren-type-annot,
    // jsx-attr-extra-close-paren, hook-multiline-array-stray-paren, jsx-void-element-promotion, …)
    // BEFORE Vite ever transforms the file. Without this, mangled-arrow only
    // gets caught by the convergence guard's last-ditch drain — by which time
    // Vite has already errored, slm-repair has churned, and the cascade has
    // started reaching template-basement.
    const drained = drainKnownTypos(c, f.path);
    const sanitizeChanged = c !== f.content;
    const drainChanged = drained.content !== c;
    c = drained.content;

    if (sanitizeChanged || drainChanged) {
      const parts: string[] = [];
      if (sanitizeChanged) parts.push('imports/parens');
      if (drainChanged && drained.fixesApplied.length > 0) {
        parts.push(`drain: ${drained.fixesApplied.map((d) => `${d.id}×${d.count}`).join(', ')}`);
      }
      runnerLog.info('Sanitize', `Fixed ${f.path} (${parts.join('; ')})`);

      // Honesty check: if the drain ran but a known-broken pattern is STILL
      // present after the rewrite, the rule didn't match the bytes we just
      // wrote — surface it loudly so the next run doesn't bury the bug.
      const residuals = auditResidualBrokenPatterns([{ path: f.path, content: c }]);
      if (residuals.length > 0) {
        const r = residuals[0];
        runnerLog.error(
          'Sanitize',
          `${f.path}: residual ${r.pattern} at line ${r.line} despite drain — investigate (snippet: ${r.snippet.trim()})`,
        );
      }
    } else {
      runnerLog.debug('Sanitize', `no-op on ${f.path}`);
    }
    return { ...f, content: c };
  });
}

/**
 * Returns true if the dev-server output line indicates a parser/syntax error
 * that the AST auto-fix engine should attempt to repair. Centralized so
 * Babel-wording vs esbuild-wording variants stay in sync — without each
 * variant listed here, post-start auto-fix never fires for those errors
 * (e.g. Babel's "Missing semicolon." for the same defect esbuild reports
 * as `Expected ";" but found "{"`).
 */
// Part C convergence guard helper. Pure so it can be unit-tested.
// Records that `key` has produced another parse error this run and returns
// whether a one-time warning should be emitted (threshold reached and not
// previously warned). Mutates `counts` and `warned` in place.
export function recordRecurrenceAndShouldWarn(
  counts: Map<string, number>,
  warned: Set<string>,
  key: string,
  threshold: number,
): { count: number; shouldWarn: boolean } {
  const next = (counts.get(key) ?? 0) + 1;
  counts.set(key, next);
  if (next >= threshold && !warned.has(key)) {
    warned.add(key);
    return { count: next, shouldWarn: true };
  }
  return { count: next, shouldWarn: false };
}

// Pure helper that performs the whole-project drain pass logic. Exported
// so the runner's two whole-project sweep call sites (post-success and
// retry-path) can share it AND so tests can verify the behavior without
// spinning up a WebContainer. Returns the list of files whose content
// changed and the per-file fix counts.
export async function runWholeProjectDrain(args: {
  files: { path: string; content: string }[];
  read: (path: string) => Promise<string | null>;
  write: (path: string, content: string) => Promise<void>;
  drain: (content: string, path: string) => { content: string; fixesApplied: { id: string; count: number }[] };
}): Promise<{
  touched: { path: string; content: string }[];
  aggregate: Record<string, number>;
}> {
  const codeRe = /\.(?:tsx?|jsx?|mjs|cjs)$/;
  const touched: { path: string; content: string }[] = [];
  const aggregate: Record<string, number> = {};
  for (const f of args.files) {
    if (!codeRe.test(f.path)) continue;
    if (f.path.includes('node_modules')) continue;
    if (/(?:^|\/)vite\.config\.[jt]s$/.test(f.path)) continue;
    let fresh: string | null = f.content;
    try { fresh = await args.read(f.path); } catch { fresh = f.content; }
    const baseline = fresh ?? f.content;
    const result = args.drain(baseline, f.path);
    if (result.content !== baseline) {
      await args.write(f.path, result.content);
      touched.push({ path: f.path, content: result.content });
      for (const fix of result.fixesApplied) {
        aggregate[fix.id] = (aggregate[fix.id] ?? 0) + fix.count;
      }
    }
  }
  return { touched, aggregate };
}

export function isParseErrorOutput(output: string): boolean {
  return (
    output.includes('vite:react-babel') ||
    output.includes('Unexpected token') ||
    output.includes('Unexpected ";"') ||
    output.includes('Expected ">"') ||
    output.includes('Missing semicolon') ||
    output.includes('Expected ";"') ||
    output.includes('Unexpected ")"') ||
    // Only treat Pre-transform errors as parser errors when they carry a
    // (line:col) tuple — otherwise they may be import-resolution or plugin
    // failures that the AST fixer can't help with.
    /Pre-transform error[\s\S]*?\(\d+:\d+\)/.test(output) ||
    (output.includes('ERROR:') && (output.includes('.tsx') || output.includes('.jsx')))
  );
}

export type RunnerStatus =
  | 'idle'
  | 'generating'
  | 'mounting'
  | 'installing'
  | 'starting'
  | 'running'
  | 'error';

export interface RunnerState {
  status: RunnerStatus;
  progress: number; // 0-100
  message: string;
  logs: string[];
  previewUrl: string | null;
  error: string | null;
}

export interface AutoRunCallbacks {
  onStatusChange: (state: RunnerState) => void;
  onLog: (log: string) => void;
  onPreviewReady: (url: string) => void;
  onError: (error: string) => void;
}

async function applyUpgradedPackageJson(
  projectFiles: { path: string; content: string }[],
  upgradedContent: string,
  log: (msg: string) => void
): Promise<void> {
  try {
    const idx = projectFiles.findIndex(f => f.path === 'package.json');
    if (idx >= 0) {
      projectFiles[idx] = { ...projectFiles[idx], content: upgradedContent };
    }
    await writeFile('package.json', upgradedContent);
    runnerLog.info('Snapshot', 'Applied upgraded package.json to WebContainer');
    log('✅ Applied upgraded package.json');
  } catch (err) {
    runnerLog.debug('Snapshot', `Failed to apply upgraded package.json (non-fatal): ${err}`);
  }
}

// Convert file array to WebContainer FileSystemTree
export function filesToFileSystemTree(
  files: { path: string; content: string }[]
): FileSystemTree {
  const tree: FileSystemTree = {};

  for (const file of files) {
    const parts = file.path.split('/');
    let current: FileSystemTree = tree;

    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];
      if (!current[dir]) {
        current[dir] = { directory: {} };
      }
      current = (current[dir] as { directory: FileSystemTree }).directory;
    }

    const fileName = parts[parts.length - 1];
    current[fileName] = { file: { contents: file.content } };
  }

  return tree;
}

// Detect project type from files
export function detectProjectType(files: { path: string; content: string }[]): {
  type: 'vite' | 'express' | 'next' | 'node' | 'static';
  devCommand: string;
  installCommand: string;
  useTypeScript: boolean;
  entryFile: string | null;
} {
  const hasPackageJson = files.some(f => f.path === 'package.json');
  const hasViteConfig = files.some(f => f.path.includes('vite.config'));
  const hasNextConfig = files.some(f => f.path.includes('next.config'));
  const hasServerTs = files.some(f => f.path === 'server.ts');
  const hasServerJs = files.some(f => f.path === 'server.js');
  const hasIndexTs = files.some(f => f.path === 'index.ts');
  const hasIndexJs = files.some(f => f.path === 'index.js');
  const hasAppTs = files.some(f => f.path === 'app.ts');
  const hasAppJs = files.some(f => f.path === 'app.js');

  // Check if project uses TypeScript
  const useTypeScript = files.some(f => f.path.endsWith('.ts') || f.path.endsWith('.tsx'));

  if (!hasPackageJson) {
    return { type: 'static', devCommand: '', installCommand: '', useTypeScript: false, entryFile: null };
  }

  if (hasNextConfig) {
    return { type: 'next', devCommand: 'npm run dev', installCommand: 'npm install', useTypeScript, entryFile: null };
  }

  if (hasViteConfig) {
    return { type: 'vite', devCommand: 'npm run dev', installCommand: 'npm install', useTypeScript, entryFile: null };
  }

  if (hasPackageJson) {
    const pkgFile = files.find(f => f.path === 'package.json');
    if (pkgFile) {
      try {
        const pkg = JSON.parse(pkgFile.content);
        const scripts = pkg.scripts || {};
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const hasViteDep = 'vite' in deps;
        const hasViteScript = Object.values(scripts).some(
          (s: any) => typeof s === 'string' && s.includes('vite')
        );
        const hasReactJsx = files.some(f =>
          f.path.endsWith('.jsx') || f.path.endsWith('.tsx')
        );
        if (hasViteDep || hasViteScript || (hasReactJsx && !hasServerJs && !hasServerTs)) {
          return { type: 'vite', devCommand: 'npm run dev', installCommand: 'npm install', useTypeScript, entryFile: null };
        }
      } catch (err) {
        console.warn('[AutoRunner] Failed to parse package.json for project type detection:', err);
      }
    }
  }

  // Detect server entry file with TypeScript priority
  if (hasServerTs) {
    return { type: 'express', devCommand: 'npm run dev', installCommand: 'npm install', useTypeScript: true, entryFile: 'server.ts' };
  }
  if (hasServerJs) {
    return { type: 'express', devCommand: 'npm run dev', installCommand: 'npm install', useTypeScript: false, entryFile: 'server.js' };
  }
  if (hasIndexTs) {
    return { type: 'node', devCommand: 'npm run dev', installCommand: 'npm install', useTypeScript: true, entryFile: 'index.ts' };
  }
  if (hasIndexJs) {
    return { type: 'node', devCommand: 'npm start', installCommand: 'npm install', useTypeScript: false, entryFile: 'index.js' };
  }
  if (hasAppTs) {
    return { type: 'node', devCommand: 'npm run dev', installCommand: 'npm install', useTypeScript: true, entryFile: 'app.ts' };
  }
  if (hasAppJs) {
    return { type: 'node', devCommand: 'npm start', installCommand: 'npm install', useTypeScript: false, entryFile: 'app.js' };
  }

  return { type: 'node', devCommand: 'npm start', installCommand: 'npm install', useTypeScript, entryFile: null };
}

// Analyze code to detect required dependencies
export function detectDependencies(code: string, useTypeScript: boolean = false): { dependencies: Record<string, string>; devDependencies: Record<string, string> } {
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {};

  // TypeScript tooling
  if (useTypeScript) {
    devDeps['typescript'] = '^5.3.0';
    devDeps['tsx'] = '^4.7.0';
    devDeps['@types/node'] = '^20.10.0';
  }

  // React ecosystem
  if (code.includes('from "react"') || code.includes("from 'react'") || code.includes('useState') || code.includes('useEffect')) {
    deps['react'] = '^18.2.0';
    deps['react-dom'] = '^18.2.0';
  }

  // React Router
  if (code.includes('react-router') || code.includes('BrowserRouter') || code.includes('useNavigate')) {
    deps['react-router-dom'] = '^6.20.0';
  }

  // State management
  if (code.includes('zustand')) deps['zustand'] = '^4.4.0';
  if (code.includes('redux') || code.includes('@reduxjs/toolkit')) {
    deps['@reduxjs/toolkit'] = '^2.0.0';
    deps['react-redux'] = '^9.0.0';
  }
  if (code.includes('jotai')) deps['jotai'] = '^2.6.0';
  if (code.includes('recoil')) deps['recoil'] = '^0.7.7';

  // UI Libraries
  if (code.includes('framer-motion') || code.includes('motion.')) deps['framer-motion'] = '^10.16.0';
  if (code.includes('lucide-react') || code.includes('from "lucide-react"')) deps['lucide-react'] = '^0.294.0';
  if (code.includes('@radix-ui')) deps['@radix-ui/react-icons'] = '^1.3.0';
  if (code.includes('tailwind-merge') || code.includes('twMerge')) deps['tailwind-merge'] = '^2.1.0';
  if (code.includes('clsx')) deps['clsx'] = '^2.0.0';
  if (code.includes('class-variance-authority') || code.includes('cva(')) deps['class-variance-authority'] = '^0.7.0';

  // Forms
  if (code.includes('react-hook-form') || code.includes('useForm')) deps['react-hook-form'] = '^7.48.0';
  if (code.includes('@hookform/resolvers')) deps['@hookform/resolvers'] = '^3.3.0';
  if (code.includes('zod') || code.includes('z.object') || code.includes('z.string')) deps['zod'] = '^3.22.0';

  // Data fetching
  if (code.includes('@tanstack/react-query') || code.includes('useQuery')) deps['@tanstack/react-query'] = '^5.0.0';
  if (code.includes('axios')) deps['axios'] = '^1.6.0';
  if (code.includes('swr')) deps['swr'] = '^2.2.0';

  // Date handling
  if (code.includes('date-fns')) deps['date-fns'] = '^2.30.0';
  if (code.includes('dayjs')) deps['dayjs'] = '^1.11.0';
  if (code.includes('moment')) deps['moment'] = '^2.29.0';

  // Charts
  if (code.includes('recharts')) deps['recharts'] = '^2.10.0';
  if (code.includes('chart.js') || code.includes('react-chartjs')) {
    deps['chart.js'] = '^4.4.0';
    deps['react-chartjs-2'] = '^5.2.0';
  }

  // Backend
  if (code.includes('express')) deps['express'] = '^4.18.2';
  if (code.includes('cors')) deps['cors'] = '^2.8.5';
  if (code.includes('body-parser')) deps['body-parser'] = '^1.20.0';
  if (code.includes('multer')) deps['multer'] = '^1.4.5-lts.1';
  if (code.includes('jsonwebtoken') || code.includes('jwt.')) deps['jsonwebtoken'] = '^9.0.0';
  if (code.includes('bcrypt')) deps['bcryptjs'] = '^2.4.3';
  if (code.includes('uuid')) deps['uuid'] = '^9.0.0';
  if (code.includes('nanoid')) deps['nanoid'] = '^5.0.0';

  // Utilities
  if (code.includes('lodash') || code.includes('_.')) deps['lodash'] = '^4.17.21';

  return { dependencies: deps, devDependencies: devDeps };
}

// Merge all dependencies - no dropping, keep everything the project needs
// Returns deps with a warning if there are many packages (install may be slow)
function mergeDependencies(
  deps: Record<string, string>,
  devDeps: Record<string, string>
): { dependencies: Record<string, string>; devDependencies: Record<string, string>; warning: string | null } {
  const totalCount = Object.keys(deps).length + Object.keys(devDeps).length;

  // Warn if many dependencies (install might be slow), but don't drop any
  const warning = totalCount > 20
    ? `Installing ${totalCount} packages - this may take longer than usual`
    : null;

  return { dependencies: deps, devDependencies: devDeps, warning };
}

// Generate complete package.json from files
export function generatePackageJson(
  projectName: string,
  files: { path: string; content: string }[],
  projectType: 'vite' | 'express' | 'next' | 'node' | 'static',
  useTypeScript: boolean = false,
  entryFile: string | null = null
): string {
  // Combine all file contents to detect dependencies
  const allCode = files.map(f => f.content).join('\n');
  const { dependencies: detectedDeps, devDependencies: detectedDevDeps } = detectDependencies(allCode, useTypeScript);

  const basePackage: Record<string, any> = {
    name: projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
    version: '1.0.0',
    type: 'module',
    scripts: {},
    dependencies: {},
    devDependencies: {}
  };

  // Determine the correct entry command for TypeScript
  const nodeCommand = useTypeScript ? 'tsx' : 'node';
  const defaultEntry = entryFile || (useTypeScript ? 'index.ts' : 'index.js');
  const serverEntry = entryFile || (useTypeScript ? 'server.ts' : 'server.js');

  switch (projectType) {
    case 'vite':
      basePackage.scripts = {
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview'
      };
      basePackage.devDependencies = {
        'vite': '^5.1.0',
        '@vitejs/plugin-react': '^4.2.0'
      };
      break;

    case 'express':
      basePackage.scripts = {
        dev: `${nodeCommand} ${serverEntry}`,
        start: `${nodeCommand} ${serverEntry}`
      };
      break;

    case 'next':
      basePackage.scripts = {
        dev: 'next dev',
        build: 'next build',
        start: 'next start'
      };
      basePackage.dependencies['next'] = '^14.0.0';
      break;

    case 'node':
      basePackage.scripts = {
        start: `${nodeCommand} ${defaultEntry}`,
        dev: `${nodeCommand} ${defaultEntry}`
      };
      break;
  }

  // Merge all detected dependencies (no dropping)
  const { dependencies: mergedDeps, devDependencies: mergedDevDeps } = mergeDependencies(
    { ...basePackage.dependencies, ...detectedDeps },
    { ...basePackage.devDependencies, ...detectedDevDeps }
  );

  basePackage.dependencies = mergedDeps;
  basePackage.devDependencies = mergedDevDeps;

  return JSON.stringify(basePackage, null, 2);
}

export interface AutoRunOptions {
  skipInstallOnFailure?: boolean; // If true, try to start server even if install fails
  forceInstall?: boolean;         // If true, always run npm install even if cached
}

let activeRunId: string | null = null;
let activeRunPromise: Promise<{ success: boolean; previewUrl: string | null; error: string | null }> | null = null;
let lastSuccessfulPreviewUrl: string | null = null;
let sessionProjectHash: string | null = null;

const CRITICAL_UI_FILES: Record<string, { exports: string[]; content: string }> = {
  'src/components/ui/toaster.tsx': {
    exports: ['Toaster'],
    content: `// @generated
import { useToast } from "@/hooks/use-toast";\n\nexport function Toaster() {\n  const { toasts, dismiss } = useToast();\n\n  if (toasts.length === 0) return null;\n\n  return (\n    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">\n      {toasts.map((toast) => (\n        <div\n          key={toast.id}\n          className={\n            "rounded-lg border p-4 shadow-lg transition-all " +\n            (toast.variant === "destructive"\n              ? "bg-red-600 text-white border-red-700"\n              : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700")\n          }\n          role="alert"\n        >\n          {toast.title && <div className="font-semibold text-sm">{toast.title}</div>}\n          {toast.description && <div className="text-sm mt-1 opacity-90">{toast.description}</div>}\n          <button\n            onClick={() => dismiss(toast.id)}\n            className="absolute top-2 right-2 text-xs opacity-50 hover:opacity-100"\n          >\n            x\n          </button>\n        </div>\n      ))}\n    </div>\n  );\n}\n`,
  },
  'src/hooks/use-toast.ts': {
    exports: ['useToast', 'toast'],
    content: `// @generated
import { useState, useCallback } from "react";\n\ninterface Toast {\n  id: string;\n  title?: string;\n  description?: string;\n  variant?: "default" | "destructive";\n}\n\nlet toastCount = 0;\nlet globalToasts: Toast[] = [];\nlet listeners: Array<() => void> = [];\n\nfunction notify() { listeners.forEach(l => l()); }\n\nexport function toast({ title, description, variant = "default" }: Omit<Toast, "id">) {\n  const id = String(++toastCount);\n  globalToasts = [...globalToasts, { id, title, description, variant }];\n  notify();\n  setTimeout(() => {\n    globalToasts = globalToasts.filter(t => t.id !== id);\n    notify();\n  }, 5000);\n  return { id, dismiss: () => { globalToasts = globalToasts.filter(t => t.id !== id); notify(); } };\n}\n\nexport function useToast() {\n  const [, setTick] = useState(0);\n  const rerender = useCallback(() => setTick(t => t + 1), []);\n\n  useState(() => { listeners.push(rerender); });\n\n  return {\n    toasts: globalToasts,\n    toast,\n    dismiss: (id: string) => { globalToasts = globalToasts.filter(t => t.id !== id); notify(); },\n  };\n}\n`,
  },
};

function hasExport(content: string, exportName: string): boolean {
  const patterns = [
    new RegExp(`export\\s+(?:function|const|class)\\s+${exportName}\\b`),
    new RegExp(`export\\s+default\\s+(?:function\\s+)?${exportName}\\b`),
    new RegExp(`export\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}`),
  ];
  return patterns.some(p => p.test(content));
}

const GENERATED_MARKERS = [
  '// @generated',
  '// auto-generated',
  '// generated by autocoder',
  '// This file was generated',
];
const USER_MARKERS = [
  '// custom',
  '// @user',
  '// @preserve',
  '// do not overwrite',
];

function hasUserMarkers(content: string): boolean {
  return USER_MARKERS.some(m => content.toLowerCase().includes(m.toLowerCase()));
}

function isOverwriteSafe(content: string): boolean {
  const trimmed = content.trim();
  if (hasUserMarkers(trimmed)) return false;
  if (trimmed.length < 500) return true;
  return GENERATED_MARKERS.some(m => trimmed.toLowerCase().includes(m.toLowerCase()));
}

function getRollupNativePatchContent(): string {
  return `/* WEBCONTAINER_PATCHED */
'use strict';

var parse, parseAsync, xxhashBase64Url, xxhashBase36, xxhashBase16;
var _loaded = false;

// Strategy 1: Load @rollup/wasm-node's own native.js (WASM-based bindings)
if (!_loaded) {
  try {
    var _wasmNativePath = require('path').join(
      require('path').dirname(require.resolve('@rollup/wasm-node/package.json')),
      'dist', 'native.js'
    );
    var _wn = require(_wasmNativePath);
    parse = _wn.parse;
    parseAsync = _wn.parseAsync;
    xxhashBase64Url = _wn.xxhashBase64Url;
    xxhashBase36 = _wn.xxhashBase36;
    xxhashBase16 = _wn.xxhashBase16;
    _loaded = true;
  } catch (_e) {}
}

// Strategy 2: Try requiring @rollup/wasm-node as a package
if (!_loaded) {
  try {
    var _wn2 = require('@rollup/wasm-node');
    if (_wn2.parse) {
      parse = _wn2.parse;
      parseAsync = _wn2.parseAsync;
      xxhashBase64Url = _wn2.xxhashBase64Url;
      xxhashBase36 = _wn2.xxhashBase36;
      xxhashBase16 = _wn2.xxhashBase16;
      _loaded = true;
    }
  } catch (_e) {}
}

// Strategy 3: Pure JS fallback stubs (sufficient for Vite dev server)
if (!_loaded) {
  function _simpleHash(input) {
    if (typeof input === 'string') {
      var h = 5381;
      for (var i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
      return h;
    }
    if (input && input.length) {
      var h2 = 5381;
      for (var j = 0; j < input.length; j++) h2 = ((h2 << 5) + h2 + (input[j] || 0)) >>> 0;
      return h2;
    }
    return 0;
  }
  parse = function() { return { body: [], type: 'Module', start: 0, end: 0 }; };
  parseAsync = function(code, opts) { return Promise.resolve(parse(code, opts)); };
  xxhashBase64Url = function(input) { return _simpleHash(input).toString(36); };
  xxhashBase36 = function(input) { return _simpleHash(input).toString(36); };
  xxhashBase16 = function(input) { return _simpleHash(input).toString(16); };
}

module.exports = { parse: parse, parseAsync: parseAsync, xxhashBase64Url: xxhashBase64Url, xxhashBase36: xxhashBase36, xxhashBase16: xxhashBase16 };
`;
}

async function patchRollupParseAstForWebContainer(
  readFile: (path: string) => Promise<string | null>,
  writeFile: (path: string, content: string) => Promise<void>,
  log: { info: (cat: string, msg: string) => void; debug: (cat: string, msg: string) => void }
): Promise<void> {
  const destPaths = [
    'node_modules/rollup/dist/es/shared/parseAst.js',
    'node_modules/rollup/dist/shared/parseAst.js',
  ];

  const safeWrapperCode = `
/* WEBCONTAINER_PARSENODE_PATCHED */
const __origConvertProgram = convertProgram;
function convertProgram_safe(buffer) {
  try { return __origConvertProgram(buffer); }
  catch(e) {
    if (e && e.message && e.message.includes('Unknown node type'))
      return { type: 'Program', sourceType: 'module', start: 0, end: 0, body: [{ type: 'EmptyStatement', start: 0, end: 0 }], comments: [] };
    throw e;
  }
}
`;

  for (const destPath of destPaths) {
    try {
      const existing = await readFile(destPath);
      if (!existing) continue;

      let content = existing;
      let applied = false;
      const alreadyPatched = existing.includes('WEBCONTAINER_PARSENODE_PATCHED');

      if (!alreadyPatched) {
        content = content.replace(
          /(\bconst\s+parseAst\s*=\s*\([^)]*\)\s*=>\s*)convertProgram\s*\(/g,
          '$1convertProgram_safe('
        );
        content = content.replace(
          /(\bconst\s+parseAstAsync\s*=\s*async[^)]*\)\s*=>\s*)convertProgram\s*\(/g,
          '$1convertProgram_safe('
        );

        if (content !== existing) {
          const exportIdx = content.lastIndexOf('\nexport ');
          if (exportIdx >= 0) {
            content = content.substring(0, exportIdx) + safeWrapperCode + content.substring(exportIdx);
          } else {
            content = content + '\n' + safeWrapperCode;
          }
          applied = true;
          log.info('RollupPatch', `Rewired parseAst to use convertProgram_safe in ${destPath}`);
        }

        if (!applied) {
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (!lines[i].includes('Unknown node type')) continue;
            let throwStart = -1;
            for (let j = i; j >= Math.max(0, i - 5); j--) {
              if (lines[j].includes('throw')) { throwStart = j; break; }
            }
            if (throwStart === -1 && lines[i].includes('throw')) throwStart = i;
            if (throwStart === -1) continue;
            let throwEnd = i;
            for (let j = i; j <= Math.min(lines.length - 1, i + 5); j++) {
              if (lines[j].includes(';')) { throwEnd = j; break; }
            }
            const indent = lines[throwStart].match(/^(\s*)/)?.[1] || '\t\t\t';
            lines[throwStart] = indent + 'return { type: "EmptyStatement", start: 0, end: 0 };';
            for (let j = throwStart + 1; j <= throwEnd; j++) lines[j] = '';
            applied = true;
            log.info('RollupPatch', `Patched throw at lines ${throwStart + 1}-${throwEnd + 1}`);
          }
          if (applied) content = '/* WEBCONTAINER_PARSENODE_PATCHED */\n' + lines.join('\n');
        }
      }

      if (!content.includes('/* trace suppressed */') && content.match(/console\.trace\s*\(/)) {
        let traceCount = 0;
        content = content.replace(/console\.trace\s*\([^)]*\)/g, () => { traceCount++; return '/* trace suppressed */'; });
        if (traceCount > 0) {
          applied = true;
          log.info('RollupPatch', `Suppressed ${traceCount} console.trace() calls in ${destPath}`);
        }
      }

      if (applied) {
        await writeFile(destPath, content);
        log.info('RollupPatch', `Successfully patched ${destPath}`);
      }
    } catch (err) {
      log.debug('RollupPatch', `Failed to patch ${destPath}: ${err}`);
    }
  }
}

async function patchViteChunkForWebContainer(
  readFile: (path: string) => Promise<string | null>,
  writeFile: (path: string, content: string) => Promise<void>,
  log: { info: (cat: string, msg: string) => void; debug: (cat: string, msg: string) => void }
): Promise<void> {
  const chunkNames = [
    'node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js',
    'node_modules/vite/dist/node/chunks/dep-BB45zftN.js',
  ];

  for (const chunkPath of chunkNames) {
    try {
      const content = await readFile(chunkPath);
      if (!content) continue;
      if (content.includes('WEBCONTAINER_VITE_PATCHED')) continue;
      if (!content.includes('transformCjsImport')) continue;

      const patched = content.replace(
        /function\s+transformCjsImport\s*\(([^)]*)\)\s*\{/,
        'function transformCjsImport($1) {\n  try {'
      ).replace(
        /\}\s*\n(function\s+__vite__injectQuery)/,
        '} catch(_tcErr) { return undefined; }\n}\n$1'
      );

      if (patched !== content) {
        await writeFile(chunkPath, '/* WEBCONTAINER_VITE_PATCHED */\n' + patched);
        log.info('VitePatch', `Wrapped transformCjsImport with try-catch in ${chunkPath}`);
        return;
      }
    } catch (_) {}
  }
}

async function patchRollupNativeForWebContainer(
  readFile: (path: string) => Promise<string | null>,
  writeFile: (path: string, content: string) => Promise<void>,
  log: { info: (cat: string, msg: string) => void; debug: (cat: string, msg: string) => void }
): Promise<boolean> {
  try {
    const rollupNative = await readFile('node_modules/rollup/dist/native.js');
    if (!rollupNative) return false;

    if (!rollupNative.includes('WEBCONTAINER_PATCHED')) {
      const replacement = getRollupNativePatchContent();
      await writeFile('node_modules/rollup/dist/native.js', replacement);
      log.info('RollupPatch', 'Replaced rollup/dist/native.js with WebContainer-compatible version');
    }

    await patchRollupParseAstForWebContainer(readFile, writeFile, log);
    await patchViteChunkForWebContainer(readFile, writeFile, log);
    return true;
  } catch (err) {
    log.debug('RollupPatch', `Could not patch rollup native.js: ${err}`);
    return false;
  }
}

const ESBUILD_BROWSER_SHIM = `/* WEBCONTAINER_PATCHED - esbuild browser-mode shim */
if (typeof self === 'undefined') globalThis.self = globalThis;
if (!globalThis.process) try { globalThis.process = require('process'); } catch(e) {}
try { Object.defineProperty(globalThis, 'crypto', { value: globalThis.crypto || require('crypto'), writable: true, configurable: true }); } catch(e) {}
var _esbuildWasmBrowser;
try { _esbuildWasmBrowser = require('esbuild-wasm/lib/browser'); } catch(e) {
  _esbuildWasmBrowser = require(require('path').join(
    require.resolve('esbuild-wasm/package.json'), '..', 'lib', 'browser.js'));
}
var _initPromise = null;
function _ensureInit() {
  if (!_initPromise) {
    _initPromise = (async () => {
      var fs = require('fs');
      var wasmPath = require('path').join(
        require.resolve('esbuild-wasm/package.json'), '..', 'esbuild.wasm');
      var wasmBytes = fs.readFileSync(wasmPath);
      var wasmModule = await WebAssembly.compile(wasmBytes);
      await _esbuildWasmBrowser.initialize({ wasmModule: wasmModule, worker: false });
    })();
  }
  return _initPromise;
}
function _wrap(fn) {
  return async function() { await _ensureInit(); return fn.apply(null, arguments); };
}
module.exports.build = _wrap(_esbuildWasmBrowser.build);
module.exports.context = _wrap(_esbuildWasmBrowser.context);
module.exports.transform = _wrap(_esbuildWasmBrowser.transform);
module.exports.formatMessages = _wrap(_esbuildWasmBrowser.formatMessages);
module.exports.analyzeMetafile = _wrap(_esbuildWasmBrowser.analyzeMetafile);
module.exports.buildSync = function() { throw new Error('buildSync not available in WebContainer WASM mode'); };
module.exports.transformSync = function() { throw new Error('transformSync not available in WebContainer WASM mode'); };
module.exports.formatMessagesSync = function() { throw new Error('formatMessagesSync not available in WebContainer WASM mode'); };
module.exports.analyzeMetafileSync = function() { throw new Error('analyzeMetafileSync not available in WebContainer WASM mode'); };
module.exports.initialize = function(opts) { return _ensureInit(); };
module.exports.stop = function() { _initPromise = null; try { _esbuildWasmBrowser.stop(); } catch(e) {} };
module.exports.version = _esbuildWasmBrowser.version;
`;

async function patchEsbuildForWebContainer(
  readFile: (path: string) => Promise<string | null>,
  writeFile: (path: string, content: string) => Promise<void>,
  log: { info: (cat: string, msg: string) => void; debug: (cat: string, msg: string) => void }
): Promise<boolean> {
  const paths = [
    'node_modules/esbuild/lib/main.js',
    'node_modules/vite/node_modules/esbuild/lib/main.js',
  ];
  let patched = false;
  for (const p of paths) {
    try {
      const content = await readFile(p);
      if (!content) continue;
      if (content.includes('WEBCONTAINER_PATCHED')) { patched = true; continue; }

      await writeFile(p, ESBUILD_BROWSER_SHIM);
      log.info('EsbuildPatch', `Replaced ${p} with browser-mode esbuild-wasm shim`);
      patched = true;
    } catch (err) {
      log.debug('EsbuildPatch', `Could not patch ${p}: ${err}`);
    }
  }
  return patched;
}

async function patchEsbuildWasmBrowserJs(
  readFile: (path: string) => Promise<string | null>,
  writeFile: (path: string, content: string) => Promise<void>,
  log: { info: (cat: string, msg: string) => void; debug: (cat: string, msg: string) => void }
): Promise<boolean> {
  const paths = [
    'node_modules/esbuild-wasm/lib/browser.js',
    'node_modules/vite/node_modules/esbuild-wasm/lib/browser.js',
  ];
  let patched = false;
  for (const p of paths) {
    try {
      const content = await readFile(p);
      if (!content) continue;
      if (content.includes('_oR=fs.read') && content.includes('_oRD=fs.readdir') && content.includes('_enoent')) { patched = true; continue; }

      const elseBranch = content.indexOf('} else {\n    let onmessage = ((postMessage) =>');
      if (elseBranch === -1) {
        log.debug('BrowserJsPatch', `Could not find else branch in ${p}`);
        continue;
      }

      let blobPart = content.substring(0, elseBranch);
      let inlinePart = content.substring(elseBranch);

      inlinePart = inlinePart.replace(
        'let fs = globalThis.fs;',
        'let fs = globalThis.fs; ' +
        'try{if(typeof require!=="undefined"){var _nfs=require("fs");' +
        'if(_nfs&&typeof _nfs.readdir==="function"){' +
        'Object.keys(_nfs).forEach(function(k){' +
        'if(typeof _nfs[k]==="function")fs[k]=_nfs[k].bind(_nfs);' +
        'else if(typeof _nfs[k]!=="undefined")fs[k]=_nfs[k];' +
        '});}}}catch(_e){} ' +
        'var _oR=fs.read,_oW=fs.write,_oWS=fs.writeSync;'
      );
      inlinePart = inlinePart.replace(
        'throw new Error("Bad write");',
        'return _oWS.call(fs,fd,buffer);'
      );
      inlinePart = inlinePart.replace(
        'throw new Error("Bad read");',
        'return _oR.call(fs,fd,buffer,offset,length,position,callback);'
      );
      const readdirPatch = 'var _oRD=fs.readdir;fs.readdir=function(p,cb){' +
        'try{_oRD.call(fs,p,function(e,r){' +
        'if(e){cb(null,[]);return;}cb(null,r);});}' +
        'catch(e){cb(null,[]);}' +
        '};\n        ';
      const writeIntercept = 'fs.write=function(fd,buf,off,len,pos,cb){' +
        'if(fd===1){postMessage(buf.slice(off,off+len));cb(null,len);return;}' +
        'if(fd===2){console.error(new TextDecoder().decode(buf.slice(off,off+len)));cb(null,len);return;}' +
        'return _oW.call(fs,fd,buf,off,len,pos,cb);' +
        '};\n        ';
      const enosysPatch =
        'function _enoent(){var e=new Error("ENOENT");e.code="ENOENT";return e;}\n        ' +
        'var _oOpen=fs.open;fs.open=function(p,flags,mode,cb){' +
        'if(typeof mode==="function"){cb=mode;mode=438;}' +
        'try{_oOpen.call(fs,p,flags,mode,function(e,fd){' +
        'if(e&&(e.code==="ENOSYS"||(e.message&&e.message.includes("not implemented")))){cb(_enoent());return;}' +
        'cb(e,fd);});}catch(e){cb(_enoent());}' +
        '};\n        ' +
        'var _oStat=fs.stat;fs.stat=function(p,cb){' +
        'try{_oStat.call(fs,p,function(e,r){' +
        'if(e&&(e.code==="ENOSYS"||(e.message&&e.message.includes("not implemented")))){cb(_enoent());return;}' +
        'cb(e,r);});}catch(e){cb(_enoent());}' +
        '};\n        ' +
        'var _oLstat=fs.lstat;fs.lstat=function(p,cb){' +
        'try{_oLstat.call(fs,p,function(e,r){' +
        'if(e&&(e.code==="ENOSYS"||(e.message&&e.message.includes("not implemented")))){cb(_enoent());return;}' +
        'cb(e,r);});}catch(e){cb(_enoent());}' +
        '};\n        ';
      inlinePart = inlinePart.replace(
        'let go = new globalThis.Go();',
        readdirPatch + writeIntercept + enosysPatch + 'let go = new globalThis.Go();'
      );

      await writeFile(p, blobPart + inlinePart);
      log.info('BrowserJsPatch', `Patched ${p} with fs.read/write/writeSync fallbacks`);
      patched = true;
    } catch (err) {
      log.debug('BrowserJsPatch', `Could not patch ${p}: ${err}`);
    }
  }
  return patched;
}

async function installWasmFallbacks(
  logFn: (output: string) => void,
  runnerLog: { info: (cat: string, msg: string) => void; debug: (cat: string, msg: string) => void },
  readFileFn?: (path: string) => Promise<string | null>
): Promise<void> {
  async function getVersion(pkgJsonPath: string): Promise<string | null> {
    if (!readFileFn) return null;
    try {
      const raw = await readFileFn(pkgJsonPath);
      if (raw) return JSON.parse(raw).version || null;
    } catch {}
    return null;
  }

  async function installPkg(spec: string, fallbackName: string): Promise<boolean> {
    try {
      const result = await runNpmInstall([spec], false, logFn, 120000, true);
      if (result.success) {
        runnerLog.info('WasmFallback', `Installed ${spec}`);
        return true;
      }
      if (spec !== fallbackName) {
        runnerLog.info('WasmFallback', `Failed ${spec}, retrying unpinned...`);
        const retry = await runNpmInstall([fallbackName], false, logFn, 120000, true);
        if (retry.success) {
          runnerLog.info('WasmFallback', `Installed ${fallbackName} (unpinned)`);
          return true;
        }
      }
      runnerLog.info('WasmFallback', `Failed to install ${fallbackName}`);
    } catch (err) {
      runnerLog.info('WasmFallback', `Error installing ${fallbackName}: ${err}`);
    }
    return false;
  }

  const topEsbuildVer = await getVersion('node_modules/esbuild/package.json');
  const viteEsbuildVer = await getVersion('node_modules/vite/node_modules/esbuild/package.json');
  const existingEsbuildWasmVer = await getVersion('node_modules/esbuild-wasm/package.json');

  const esbuildWasmVer = viteEsbuildVer || topEsbuildVer;
  if (existingEsbuildWasmVer) {
    runnerLog.info('WasmFallback', `esbuild-wasm@${existingEsbuildWasmVer} already installed (from snapshot), skipping npm install`);
  } else if (esbuildWasmVer) {
    if (viteEsbuildVer && viteEsbuildVer !== topEsbuildVer) {
      runnerLog.info('WasmFallback', `Vite esbuild@${viteEsbuildVer} differs from top-level@${topEsbuildVer}, installing esbuild-wasm@${viteEsbuildVer} (Vite priority)`);
    }
    await installPkg(`esbuild-wasm@${esbuildWasmVer}`, 'esbuild-wasm');
  } else {
    await installPkg('esbuild-wasm', 'esbuild-wasm');
  }

  const existingRollupWasmVer = await getVersion('node_modules/@rollup/wasm-node/package.json');
  if (existingRollupWasmVer) {
    runnerLog.info('WasmFallback', `@rollup/wasm-node@${existingRollupWasmVer} already installed (from snapshot), skipping npm install`);
  } else {
    const rollupVer = await getVersion('node_modules/rollup/package.json');
    const rollupSpec = rollupVer ? `@rollup/wasm-node@${rollupVer}` : '@rollup/wasm-node';
    await installPkg(rollupSpec, '@rollup/wasm-node');
  }
}

async function preFlightVerifyCriticalFiles(
  projectFiles: { path: string; content: string }[],
  log: (msg: string) => void
): Promise<number> {
  let fixCount = 0;

  for (const [filePath, spec] of Object.entries(CRITICAL_UI_FILES)) {
    const projectFile = projectFiles.find(f => f.path === filePath);
    if (!projectFile) continue;

    if (hasUserMarkers(projectFile.content)) {
      const missingExports = spec.exports.filter(name => !hasExport(projectFile.content, name));
      if (missingExports.length === 0) {
        runnerLog.debug('PreFlight', `${filePath}: user file with all exports present, OK`);
      } else {
        runnerLog.warn('PreFlight', `${filePath}: missing export(s) "${missingExports.join(', ')}" but has user markers, skipping`);
      }
      continue;
    }

    try {
      await writeFile(filePath, spec.content);
      fixCount++;
      runnerLog.success('PreFlight', `Wrote known-good ${filePath} (replacing LLM version)`);
    } catch (err) {
      runnerLog.error('PreFlight', `Failed to fix ${filePath}: ${err}`);
    }
  }

  const filePathsInProject = projectFiles.map(f => f.path);
  for (const [filePath, spec] of Object.entries(CRITICAL_UI_FILES)) {
    if (filePathsInProject.includes(filePath)) continue;

    const isReferenced = projectFiles.some(f =>
      f.content.includes(filePath.replace(/^src\//, '@/').replace(/\.tsx?$/, ''))
    );
    if (!isReferenced) continue;

    try {
      await writeFile(filePath, spec.content);
      fixCount++;
      runnerLog.success('PreFlight', `Created missing referenced file ${filePath}`);
      log(`🔧 Pre-flight: created missing ${filePath}`);
    } catch (err) {
      runnerLog.error('PreFlight', `Failed to create ${filePath}: ${err}`);
    }
  }

  return fixCount;
}

// Main auto-run pipeline
export async function autoRunProject(
  files: { path: string; content: string }[],
  projectName: string,
  callbacks: Partial<AutoRunCallbacks> = {},
  options: AutoRunOptions = {}
): Promise<{ success: boolean; previewUrl: string | null; error: string | null }> {
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  if (activeRunId && activeRunPromise) {
    runnerLog.warn('AutoRunner', `Duplicate autoRunProject call blocked (active: ${activeRunId}, attempted: ${runId})`);
    runnerLog.info('AutoRunner', `Returning result of active run ${activeRunId}`);
    return activeRunPromise;
  }

  const projectHash = files.map(f => f.path + ':' + f.content.length).join('|');
  if (lastSuccessfulPreviewUrl && sessionProjectHash === projectHash) {
    runnerLog.info('AutoRunner', `Reusing existing preview for same project (hash match), url: ${lastSuccessfulPreviewUrl}`);
    const cachedResult = { success: true, previewUrl: lastSuccessfulPreviewUrl, error: null };
    callbacks.onStatusChange?.({
      status: 'running',
      progress: 100,
      message: 'Preview ready (reconnected)',
      logs: ['Reconnected to existing preview session'],
      previewUrl: lastSuccessfulPreviewUrl,
      error: null
    });
    callbacks.onPreviewReady?.(lastSuccessfulPreviewUrl);
    return cachedResult;
  }

  activeRunId = runId;
  activeRunPromise = null;

  const state: RunnerState = {
    status: 'idle',
    progress: 0,
    message: '',
    logs: [],
    previewUrl: null,
    error: null
  };

  const updateState = (updates: Partial<RunnerState>) => {
    Object.assign(state, updates);
    callbacks.onStatusChange?.(state);
  };

  const log = (message: string) => {
    state.logs.push(message);
    callbacks.onLog?.(message);
  };

  const unsubPreWarm = onPreWarmProgress((_status, message) => {
    log(message);
  });

  const runPipeline = async (): Promise<{ success: boolean; previewUrl: string | null; error: string | null }> => {
  try {
    runnerLog.separator(`AUTO-RUN: ${projectName} [${runId}]`);
    runnerLog.startTimer('auto-run-total');

    if (!isWebContainerSupported()) {
      runnerLog.error('AutoRunner', 'WebContainer not supported in this browser');
      throw new Error('WebContainer not supported in this browser. Please use Chrome or Edge.');
    }
    runnerLog.success('AutoRunner', 'WebContainer support confirmed');

    updateState({ status: 'generating', progress: 10, message: 'Analyzing project...' });
    log('🔍 Analyzing project structure...');

    const projectType = detectProjectType(files);
    runnerLog.info('Pipeline', `Project analysis complete`, {
      type: projectType.type,
      typescript: projectType.useTypeScript,
      entryFile: projectType.entryFile || 'default',
      devCommand: projectType.devCommand,
      totalFiles: files.length,
    });
    log(`📦 Detected project type: ${projectType.type}`);

    // Step 2: Ensure package.json exists with all dependencies
    let projectFiles = [...files];
    const hasPackageJson = files.some(f => f.path === 'package.json');

    if (!hasPackageJson && projectType.type !== 'static') {
      runnerLog.info('Pipeline', 'No package.json found, generating one');
      log('📝 Generating package.json with dependencies...');
      log(`   TypeScript: ${projectType.useTypeScript ? 'Yes' : 'No'}, Entry: ${projectType.entryFile || 'default'}`);
      const packageJson = generatePackageJson(projectName, files, projectType.type, projectType.useTypeScript, projectType.entryFile);
      projectFiles.push({ path: 'package.json', content: packageJson });
      try {
        const parsed = JSON.parse(packageJson);
        const depCount = Object.keys(parsed.dependencies || {}).length;
        const devDepCount = Object.keys(parsed.devDependencies || {}).length;
        runnerLog.success('Pipeline', `Generated package.json: ${depCount} deps, ${devDepCount} devDeps`, {
          dependencies: Object.keys(parsed.dependencies || {}).join(', '),
          devDependencies: Object.keys(parsed.devDependencies || {}).join(', '),
        });
      } catch (err) {
        runnerLog.warn('Pipeline', `Failed to parse generated package.json for logging: ${err}`);
      }
    } else if (hasPackageJson) {
      // Enhance existing package.json with missing dependencies (with optimization)
      const existingPkg = files.find(f => f.path === 'package.json');
      if (existingPkg) {
        try {
          const pkg = JSON.parse(existingPkg.content);
          const allCode = files.map(f => f.content).join('\n');
          const { dependencies: detectedDeps, devDependencies: detectedDevDeps } = detectDependencies(allCode, projectType.useTypeScript);

          // Merge all dependencies (no dropping)
          const allDeps = { ...pkg.dependencies, ...detectedDeps };
          const allDevDeps = { ...pkg.devDependencies, ...detectedDevDeps };
          const { dependencies: finalDeps, devDependencies: finalDevDeps, warning } = mergeDependencies(allDeps, allDevDeps);

          pkg.dependencies = finalDeps;
          pkg.devDependencies = finalDevDeps;

          // Update the file
          projectFiles = projectFiles.map(f =>
            f.path === 'package.json'
              ? { ...f, content: JSON.stringify(pkg, null, 2) }
              : f
          );
          const depCount = Object.keys(finalDeps).length;
          const devDepCount = Object.keys(finalDevDeps).length;
          runnerLog.success('Pipeline', `Enhanced package.json: ${depCount} deps, ${devDepCount} devDeps`);
          log('✅ Enhanced package.json with detected dependencies');
          if (warning) {
            runnerLog.warn('Pipeline', warning);
            log(`   ${warning}`);
          }
        } catch (e) {
          runnerLog.warn('Pipeline', `Could not parse existing package.json: ${e}`);
          log('⚠️ Could not parse existing package.json');
        }
      }
    }

    // Vite/Tailwind/PostCSS rules now live in vite-tailwind-doctor.ts.
    // One preflight pass replaces the previous scattered Tailwind v4 leak
    // hardening, postcss/tailwind config writers, and vite.config injection.
    if (projectType.type === 'vite') {
      const filesMutable = [...projectFiles];
      const report = runViteTailwindDoctor(
        { files: filesMutable, log: (m: string) => log(m) },
        'preflight',
      );
      if (report.fixesApplied.length > 0) {
        const ids = report.fixesApplied.map((f: { id: string }) => f.id).join(', ');
        runnerLog.info('Pipeline', `Vite/Tailwind Doctor (preflight): ${report.fixesApplied.length} fix(es) — ${ids}`);
        log(`🩺 Vite/Tailwind Doctor: applied ${report.fixesApplied.length} fix(es) (preflight)`);
      }
      projectFiles = filesMutable;
    }

    updateState({ progress: 20, message: 'Project analyzed' });

    // Step 3: Sanitize LLM output before mounting
    projectFiles = sanitizeLLMOutput(projectFiles);

    // Step 3b: Mount files to WebContainer
    updateState({ status: 'mounting', progress: 30, message: 'Setting up project files...' });
    runnerLog.separator('MOUNTING FILES');
    runnerLog.info('Pipeline', `Mounting ${projectFiles.length} project files`);
    log('📁 Mounting project files...');

    // Separate package.json to write it directly (avoids mount truncation issues)
    const pkgIdx = projectFiles.findIndex(f => f.path === 'package.json');
    const pkgContent = pkgIdx >= 0 ? projectFiles[pkgIdx].content : null;
    const filesWithoutPkg = pkgIdx >= 0
      ? [...projectFiles.slice(0, pkgIdx), ...projectFiles.slice(pkgIdx + 1)]
      : projectFiles;

    // Mount all files except package.json
    const fileTree = filesToFileSystemTree(filesWithoutPkg);
    await mountFiles(fileTree);
    log(`✅ Mounted ${filesWithoutPkg.length} files`);

    // Scrub stale config files left over in the cached WebContainer FS from a
    // previous run. The Vite/Tailwind doctor renames legacy postcss configs
    // (e.g. postcss.config.js → postcss.config.cjs) inside ctx.files, but
    // mountFiles only writes — it never deletes. When the npm-install step is
    // skipped because deps are cached, the WC FS keeps the old config and Vite
    // loads it instead of the new one, surfacing as `Cannot find module
    // '@tailwindcss/postcss'`. Explicitly remove the stale variants.
    {
      const projectFilePaths = new Set(projectFiles.map(f => f.path));
      const staleCandidates = [
        'postcss.config.js',
        'postcss.config.mjs',
        'postcss.config.ts',
      ];
      const removed: string[] = [];
      for (const candidate of staleCandidates) {
        if (projectFilePaths.has(candidate)) continue; // intended to be present
        const wasRemoved = await tryRemoveFile(candidate);
        if (wasRemoved) removed.push(candidate);
      }
      if (removed.length > 0) {
        runnerLog.info('Pipeline', `Scrubbed stale config(s) from cached WC FS: ${removed.join(', ')}`);
        log(`🧽 Removed stale config(s) from cache: ${removed.join(', ')}`);
      }
    }

    // Handle package.json with special care for large files (WebContainer has ~16KB write limit)
    const MAX_SAFE_SIZE = 15000; // 15KB to leave buffer
    let pendingDeps: Record<string, string> = {};
    let pendingDevDeps: Record<string, string> = {};
    let useBatchedInstall = false;
    let originalPkgData: Record<string, unknown> | null = null;

    if (pkgContent) {
      log('📝 Writing package.json...');

      if (pkgContent.length > MAX_SAFE_SIZE) {
        // Large package.json - use batched install strategy
        log(`   Package.json is ${pkgContent.length} bytes (>${MAX_SAFE_SIZE}), using batched install...`);
        useBatchedInstall = true;

        try {
          const fullPkg = JSON.parse(pkgContent);
          originalPkgData = fullPkg; // Save for later restoration

          // Extract dependencies for batched install later
          pendingDeps = fullPkg.dependencies || {};
          pendingDevDeps = fullPkg.devDependencies || {};

          // Create minimal package.json preserving ALL fields except deps
          const minimalPkg = { ...fullPkg };
          minimalPkg.dependencies = {};
          minimalPkg.devDependencies = {};

          const minimalContent = JSON.stringify(minimalPkg, null, 2);
          await writeFile('package.json', minimalContent);
          log(`✅ Wrote minimal package.json (${minimalContent.length} bytes)`);
          log(`   Will install ${Object.keys(pendingDeps).length} deps + ${Object.keys(pendingDevDeps).length} devDeps in batches`);
        } catch (err) {
          log(`⚠️ Failed to parse package.json for batched install: ${err}`);
          useBatchedInstall = false;
        }
      }

      if (!useBatchedInstall) {
        // Standard write with retry for smaller files
        let writeSuccess = false;
        for (let attempt = 1; attempt <= 3 && !writeSuccess; attempt++) {
          try {
            await writeFile('package.json', pkgContent);
            const readBack = await readFile('package.json');

            if (readBack === pkgContent) {
              writeSuccess = true;
              log('✅ package.json verified');
            } else if (readBack.length < pkgContent.length * 0.9) {
              log(`⚠️ Possible truncation (attempt ${attempt}): wrote ${pkgContent.length}, read ${readBack.length}`);
              if (attempt < 3) {
                await new Promise(r => setTimeout(r, 100 * attempt));
              }
            } else {
              writeSuccess = true;
              log('✅ package.json written');
            }
          } catch (err) {
            log(`   Write attempt ${attempt} failed: ${err}`);
          }
        }

        // If all retries failed, fall back to batched install
        if (!writeSuccess) {
          log('⚠️ Standard write failed, switching to batched install...');
          try {
            const fullPkg = JSON.parse(pkgContent);
            originalPkgData = fullPkg;
            pendingDeps = fullPkg.dependencies || {};
            pendingDevDeps = fullPkg.devDependencies || {};
            useBatchedInstall = true;

            const minimalPkg = { ...fullPkg };
            minimalPkg.dependencies = {};
            minimalPkg.devDependencies = {};
            await writeFile('package.json', JSON.stringify(minimalPkg, null, 2));
          } catch (err) {
            log(`⚠️ Could not switch to batched install: ${err}`);
            runnerLog.error('AutoRunner', `Could not switch to batched install: ${err}`);
          }
        }
      }
    }

    updateState({ progress: 40, message: 'Files mounted' });

    // Step 4: Install dependencies (with caching or batched install)
    if (projectType.type !== 'static') {
      runnerLog.separator('DEPENDENCY INSTALL');
      const pkgFile = projectFiles.find(f => f.path === 'package.json');
      const pkgChanged = pkgFile ? setPackageJsonHash(pkgFile.content) : true;
      const hasExistingModules = await hasNodeModules();

      const shouldSkipInstall = hasExistingModules && !pkgChanged && !options.forceInstall && !useBatchedInstall;

      const preWarmReady = getPreWarmStatus() === 'ready';
      let isPreWarmed = preWarmReady && hasExistingModules;

      if (preWarmReady && !hasExistingModules) {
        runnerLog.warn('Pipeline', 'Pre-warm status is ready but hasNodeModules returned false — trusting pre-warm status');
        isPreWarmed = true;
      }

      if (!isPreWarmed && !shouldSkipInstall && !useBatchedInstall) {
        const pwStatus = getPreWarmStatus();
        if (pwStatus === 'booting' || pwStatus === 'installing') {
          updateState({ status: 'installing', progress: 45, message: 'Waiting for pre-installed packages...' });
          log('⏳ Pre-warm in progress, waiting for it to finish...');
          const preWarmSucceeded = await awaitPreWarm(120000);
          if (preWarmSucceeded) {
            const nowHasModules = await hasNodeModules();
            isPreWarmed = nowHasModules;
            if (isPreWarmed) {
              log('✅ Pre-warm finished, using pre-installed packages');
            }
          } else {
            log('⚠️ Pre-warm did not finish in time, running full install...');
          }
        }
      }

      runnerLog.info('Pipeline', 'Dependency install decision', {
        hasExistingModules,
        pkgChanged,
        forceInstall: options.forceInstall || false,
        useBatchedInstall,
        isPreWarmed,
        preWarmStatus: getPreWarmStatus(),
        decision: shouldSkipInstall ? 'SKIP (cached)' : isPreWarmed ? 'PRE-WARM (install extras only)' : useBatchedInstall ? 'BATCHED' : 'FULL INSTALL',
      });

      if (shouldSkipInstall) {
        runnerLog.success('Pipeline', 'Skipping npm install - dependencies cached and unchanged');
        log('⚡ Dependencies cached, skipping npm install');
        updateState({ progress: 70, message: 'Using cached dependencies' });
      } else if (isPreWarmed && !useBatchedInstall) {
        updateState({ status: 'installing', progress: 50, message: 'Using pre-installed packages...' });
        runnerLog.info('Pipeline', 'Using pre-warmed packages, checking for extras...');
        log('⚡ Core packages pre-installed, checking for extras...');

        const { deps: preWarmedDeps, devDeps: preWarmedDevDeps } = getPreWarmedPackages();
        const allPreWarmed = { ...preWarmedDeps, ...preWarmedDevDeps };

        try {
          const currentPkg = pkgContent ? JSON.parse(pkgContent || '{}') : {};
          const projectDeps = currentPkg.dependencies || {};
          const projectDevDeps = currentPkg.devDependencies || {};

          const extraDeps = Object.keys(projectDeps).filter(d => !allPreWarmed[d]);
          const extraDevDeps = Object.keys(projectDevDeps).filter(d => !allPreWarmed[d]);

          runnerLog.info('Pipeline', `Pre-warm diff: ${extraDeps.length} extra deps, ${extraDevDeps.length} extra devDeps`, {
            extraDeps: extraDeps.join(', ') || '(none)',
            extraDevDeps: extraDevDeps.join(', ') || '(none)',
            cachedDeps: Object.keys(preWarmedDeps).length,
            cachedDevDeps: Object.keys(preWarmedDevDeps).length,
          });

          if (extraDeps.length > 0 || extraDevDeps.length > 0) {
            log(`📦 Installing ${extraDeps.length + extraDevDeps.length} extra packages...`);
            updateState({ progress: 55, message: `Installing ${extraDeps.length + extraDevDeps.length} extra packages...` });

            if (extraDeps.length > 0) {
              const result = await runNpmInstall(extraDeps, false, (out) => log(out), 120000, true);
              if (!result.success) {
                runnerLog.warn('Pipeline', 'Some extra dependency packages failed');
                log('⚠️ Some extra packages failed, continuing...');
              }
            }
            if (extraDevDeps.length > 0) {
              const result = await runNpmInstall(extraDevDeps, true, (out) => log(out), 120000, true);
              if (!result.success) {
                runnerLog.warn('Pipeline', 'Some extra devDependency packages failed');
                log('⚠️ Some extra dev packages failed, continuing...');
              }
            }
            await fixBinPermissions();
            runnerLog.success('Pipeline', 'Extra packages installed');
            log('✅ Extra packages installed');
          } else {
            runnerLog.success('Pipeline', 'All packages already pre-installed, no extras needed');
            log('✅ All packages already pre-installed');
          }

          await fixBinPermissions();
          triggerSnapshotBuild(projectFiles).then(upgraded => {
            if (upgraded) applyUpgradedPackageJson(projectFiles, upgraded, log);
          }).catch(() => {});
        } catch (e) {
          runnerLog.warn('Pipeline', `Could not diff packages: ${e}, falling back to full install`);
          log('⚠️ Could not diff packages, running full install...');
          await installDependencies((output) => log(output));
          triggerSnapshotBuild(projectFiles).then(upgraded => {
            if (upgraded) applyUpgradedPackageJson(projectFiles, upgraded, log);
          }).catch(() => {});
        }

        updateState({ progress: 70, message: 'Dependencies ready' });
      } else if (useBatchedInstall) {
        updateState({ status: 'installing', progress: 50, message: 'Installing packages in batches...' });

        const allDeps = Object.entries(pendingDeps);
        const allDevDeps = Object.entries(pendingDevDeps);
        const BATCH_SIZE = 10;

        runnerLog.info('Pipeline', `Batched install: ${allDeps.length} deps + ${allDevDeps.length} devDeps in batches of ${BATCH_SIZE}`);
        log(`📦 Installing ${allDeps.length} dependencies in batches...`);

        // Install regular dependencies in batches
        for (let i = 0; i < allDeps.length; i += BATCH_SIZE) {
          const batch = allDeps.slice(i, i + BATCH_SIZE);
          const pkgSpecs = batch.map(([name, version]) => {
            const ver = String(version);
            return ver.startsWith('^') || ver.startsWith('~') || ver === '*' || ver === 'latest'
              ? name
              : `${name}@${ver}`;
          });

          const batchNum = Math.floor(i / BATCH_SIZE) + 1;
          const totalBatches = Math.ceil(allDeps.length / BATCH_SIZE);
          log(`   Batch ${batchNum}/${totalBatches}: ${pkgSpecs.join(' ')}`);

          const progress = 50 + Math.floor((i / allDeps.length) * 15);
          updateState({ progress, message: `Installing batch ${batchNum}/${totalBatches}...` });

          const result = await runNpmInstall(pkgSpecs, false, (out) => log(out));
          if (!result.success) {
            log(`   ⚠️ Some packages in batch ${batchNum} failed, continuing...`);
          }
        }

        // Install dev dependencies
        if (allDevDeps.length > 0) {
          log(`📦 Installing ${allDevDeps.length} dev dependencies...`);
          for (let i = 0; i < allDevDeps.length; i += BATCH_SIZE) {
            const batch = allDevDeps.slice(i, i + BATCH_SIZE);
            const pkgSpecs = batch.map(([name, version]) => {
              const ver = String(version);
              return ver.startsWith('^') || ver.startsWith('~') || ver === '*' || ver === 'latest'
                ? name
                : `${name}@${ver}`;
            });

            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(allDevDeps.length / BATCH_SIZE);
            log(`   DevDep batch ${batchNum}/${totalBatches}: ${pkgSpecs.join(' ')}`);

            const result = await runNpmInstall(pkgSpecs, true, (out) => log(out));
            if (!result.success) {
              log(`   ⚠️ Some dev packages in batch ${batchNum} failed, continuing...`);
            }
          }
        }

        // Restore full package.json with dependencies after install
        if (originalPkgData) {
          try {
            // Read current package.json (npm may have updated versions)
            const currentPkgContent = await readFile('package.json');
            const currentPkg = JSON.parse(currentPkgContent);

            // Merge: keep npm's installed versions, restore original metadata
            const restoredPkg = {
              ...originalPkgData,
              dependencies: currentPkg.dependencies || {},
              devDependencies: currentPkg.devDependencies || {}
            };

            // Write in chunks if still too large (unlikely after npm normalizes versions)
            const restoredContent = JSON.stringify(restoredPkg, null, 2);
            if (restoredContent.length <= MAX_SAFE_SIZE) {
              await writeFile('package.json', restoredContent);
              log('✅ Restored full package.json');
            } else {
              log('   Package.json still large, keeping minimal version');
            }
          } catch (err) {
            log(`⚠️ Could not restore package.json: ${err}`);
          }
        }

        log('✅ Batched install complete');
        await fixBinPermissions();
        triggerSnapshotBuild(projectFiles).then(upgraded => {
          if (upgraded) applyUpgradedPackageJson(projectFiles, upgraded, log);
        }).catch(() => {});
        updateState({ progress: 70, message: 'Dependencies installed' });
      } else {
        updateState({ status: 'installing', progress: 50, message: 'Installing npm packages...' });
        const reason = hasExistingModules ? 'Dependencies changed, reinstalling' : 'Fresh install';
        runnerLog.info('Pipeline', `Full npm install: ${reason}`);
        log(hasExistingModules ? '📦 Dependencies changed, reinstalling...' : '📦 Running npm install...');

        const installResult = await installDependencies((output) => {
          log(output);
        });

        if (!installResult.success) {
          runnerLog.warn('Pipeline', 'npm install had issues, attempting to proceed', {
            exitCode: installResult.exitCode,
            errorCount: installResult.errors.length,
          });
          log('⚠️ npm install had issues, attempting to proceed anyway...');
          updateState({ progress: 70, message: 'Install incomplete, trying to start...' });
        } else {
          runnerLog.success('Pipeline', 'Full npm install completed');
          log('✅ Dependencies installed');
          triggerSnapshotBuild(projectFiles).then(upgraded => {
            if (upgraded) applyUpgradedPackageJson(projectFiles, upgraded, log);
          }).catch(() => {});
          updateState({ progress: 70, message: 'Dependencies installed' });
        }
        await fixBinPermissions();
      }
    }

    // Step 4.5: Pre-flight verify critical UI files before dev server start
    runnerLog.separator('PRE-FLIGHT CHECK');
    updateState({ progress: 75, message: 'Verifying critical files...' });
    const preFlightFixes = await preFlightVerifyCriticalFiles(projectFiles, log);
    if (preFlightFixes > 0) {
      runnerLog.success('PreFlight', `Fixed ${preFlightFixes} critical file(s) before dev server start`);
    } else {
      runnerLog.success('PreFlight', 'All critical files verified OK');
    }

    // PreFlight residual audit — re-scan every code file for known-broken
    // patterns that the pre-mount sanitize SHOULD have eliminated. If any
    // survive, drain again (up to 3 iterations). Without this, a regex
    // shape that escaped the first drain pass slips through to Vite,
    // triggering the convergence guard's last-ditch drain — by which time
    // template-basement is one step away.
    {
      let auditPass = 0;
      const MAX_AUDIT_PASSES = 3;
      while (auditPass < MAX_AUDIT_PASSES) {
        const residuals = auditResidualBrokenPatterns(projectFiles);
        if (residuals.length === 0) {
          if (auditPass > 0) {
            runnerLog.success('PreFlight', `Residual audit: clean after ${auditPass} extra drain pass(es)`);
          }
          break;
        }
        auditPass++;
        runnerLog.warn(
          'PreFlight',
          `Residual audit pass ${auditPass}: ${residuals.length} hit(s) — ${residuals.slice(0, 5).map((r) => `${r.file}:${r.line} ${r.pattern}`).join(', ')}${residuals.length > 5 ? ', …' : ''}`,
        );
        const offendingPaths = new Set(residuals.map((r) => r.file));
        for (let i = 0; i < projectFiles.length; i++) {
          const f = projectFiles[i];
          if (!offendingPaths.has(f.path)) continue;
          const drained = drainKnownTypos(f.content, f.path);
          if (drained.content !== f.content) {
            try {
              await writeFile(f.path, drained.content);
              projectFiles[i] = { ...f, content: drained.content };
              runnerLog.info(
                'PreFlight',
                `Drained residuals in ${f.path}: ${drained.fixesApplied.map((d) => `${d.id}×${d.count}`).join(', ')}`,
              );
            } catch (err) {
              runnerLog.warn('PreFlight', `Failed to write drained ${f.path}: ${err}`);
            }
          }
        }
        if (auditPass === MAX_AUDIT_PASSES) {
          const stillResidual = auditResidualBrokenPatterns(projectFiles);
          if (stillResidual.length > 0) {
            runnerLog.error(
              'PreFlight',
              `Residual audit exhausted ${MAX_AUDIT_PASSES} passes; ${stillResidual.length} broken pattern(s) remain. Vite will likely fail on these.`,
            );
          }
        }
      }
    }

    // Step 4.6: Vite/Tailwind Doctor — startup phase. Re-runs all rules
    // against on-disk content in case anything regressed between mount and
    // dev server start. All Vite/Tailwind/PostCSS logic lives in
    // vite-tailwind-doctor.ts.
    if (projectType.type === 'vite') {
      try {
        const filesOnDisk: { path: string; content: string }[] = [];
        for (const candidate of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.cts', 'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.cts', 'vitest.workspace.ts', 'vitest.workspace.js', 'tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.cjs', 'postcss.config.cjs', 'postcss.config.js']) {
          try {
            const content = await readFile(candidate);
            if (content) filesOnDisk.push({ path: candidate, content });
          } catch { /* missing is fine */ }
        }
        const startupReport = runViteTailwindDoctor(
          { files: filesOnDisk, log: (m: string) => log(m) },
          'startup',
        );
        for (const change of startupReport.codeChanges) {
          if (change.fixed === '') continue;
          await writeFile(change.file, change.fixed);
        }
        if (startupReport.fixesApplied.length > 0) {
          const ids = startupReport.fixesApplied.map((f: { id: string }) => f.id).join(', ');
          runnerLog.info('PreFlight', `Vite/Tailwind Doctor (startup): ${startupReport.fixesApplied.length} fix(es) — ${ids}`);
        } else {
          runnerLog.success('PreFlight', 'Vite/Tailwind Doctor: clean');
        }
      } catch (err) {
        runnerLog.warn('PreFlight', `Vite/Tailwind Doctor failed: ${err}`);
      }
    }

    if (projectType.type === 'vite') {
      try {
        const container = await getWebContainer();
        await container.fs.rm('node_modules/.vite', { recursive: true });
        runnerLog.info('PreFlight', 'Cleared Vite dep cache (node_modules/.vite)');
      } catch (_) {
      }
    }

    if (projectType.type === 'vite') {
      await installWasmFallbacks((out) => log(out), runnerLog, readFile);
      await patchRollupNativeForWebContainer(readFile, writeFile, runnerLog);
      await patchEsbuildForWebContainer(readFile, writeFile, runnerLog);
      await patchEsbuildWasmBrowserJs(readFile, writeFile, runnerLog);
    }

    // Step 5: Start dev server with error-fix retry loop
    runnerLog.separator('DEV SERVER');
    updateState({ status: 'starting', progress: 80, message: 'Starting development server...' });
    runnerLog.info('Pipeline', 'Starting dev server...');
    log('🚀 Starting development server...');

    const maxFixAttempts = 3;
    let fixAttempt = 0;
    let url: string = '';
    let devServerStarted = false;
    const errorLines: string[] = [];
    let needsReinstall = false;

    while (fixAttempt < maxFixAttempts && !devServerStarted) {
      try {
        const errorCollector = (output: string) => {
          log(output);
          if (output.includes('error') || output.includes('Error') || output.includes('ERROR') ||
              output.includes('Cannot find') || output.includes('Failed to resolve') ||
              output.includes('SyntaxError') || output.includes('Module not found')) {
            errorLines.push(output);
          }
        };
        const postStartErrors: string[] = [];
        const fileFixTimestamps = new Map<string, number>();
        const FILE_FIX_DEBOUNCE_MS = 5000;
        const astFixedFiles = new Map<string, number>();
        const AST_FIX_CLAIM_MS = FILE_FIX_DEBOUNCE_MS;
        const normalizeFixPath = (p: string) => {
          let s = p.replace(/\\/g, '/');
          const known = s.match(/(?:^|\/)((?:src|lib|components|pages|app|utils|hooks|shared|server|api|routes|styles)\/.+)$/);
          if (known) return known[1];
          s = s.replace(/^\/+/, '').replace(/^home\/[^/]+\//, '').replace(/^\.\//, '');
          return s;
        };
        const wasJustAstFixed = (filePath: string): boolean => {
          const key = normalizeFixPath(filePath);
          const ts = astFixedFiles.get(key) || 0;
          return Date.now() - ts < AST_FIX_CLAIM_MS;
        };
        const claimAstFix = (filePath: string) => {
          const key = normalizeFixPath(filePath);
          astFixedFiles.set(key, Date.now());
        };

        const fixFileFromError = async (filePath: string) => {
          if (wasJustAstFixed(filePath) || isAstFixPendingFor(filePath)) {
            runnerLog.debug('PostStartFix', `Skipping sanitize on ${filePath} — AST fixer just touched it or has a pending fix`);
            return;
          }
          const now = Date.now();
          const lastFix = fileFixTimestamps.get(filePath) || 0;
          if (now - lastFix < FILE_FIX_DEBOUNCE_MS) return;
          fileFixTimestamps.set(filePath, now);
          try {
            const content = await readFile(filePath);
            if (content) {
              const sanitized = sanitizeLLMOutput([{ path: filePath, content }]);
              const drained = drainKnownTypos(sanitized[0].content, filePath);
              const finalContent = drained.content;
              if (finalContent !== content) {
                await writeFile(filePath, finalContent);
                const idx = projectFiles.findIndex(f => f.path === filePath);
                if (idx >= 0) {
                  projectFiles[idx] = { ...projectFiles[idx], content: finalContent };
                }
                const drainSummary = drained.fixesApplied.length > 0
                  ? ` + drain: ${drained.fixesApplied.map((f) => `${f.id}×${f.count}`).join(', ')}`
                  : '';
                runnerLog.info('PostStartFix', `Sanitized ${filePath}${drainSummary}`);
                log(`🔧 Post-start fix: sanitized ${filePath}${drainSummary}`);
              }
            }
          } catch (e) {
            runnerLog.warn('PostStartFix', `Failed to fix ${filePath}: ${e}`);
          }
        };

        const fixPostcssError = async () => {
          const lastFix = fileFixTimestamps.get('__postcss__') || 0;
          if (Date.now() - lastFix < FILE_FIX_DEBOUNCE_MS) return;
          fileFixTimestamps.set('__postcss__', Date.now());
          try {
            const cssFiles = projectFiles.filter(f => f.path.endsWith('.css'));
            for (const cssFile of cssFiles) {
              const content = await readFile(cssFile.path);
              if (content && /@import\s*["']tailwindcss/.test(content)) {
                let fixed = content.replace(
                  /@import\s*["']tailwindcss\/(?:base|preflight)["']\s*;?/g, '@tailwind base;'
                ).replace(
                  /@import\s*["']tailwindcss\/components["']\s*;?/g, '@tailwind components;'
                ).replace(
                  /@import\s*["']tailwindcss\/utilities["']\s*;?/g, '@tailwind utilities;'
                ).replace(
                  /@import\s*(?:url\s*\(\s*)?["']tailwindcss["']\s*\)?\s*;?/g,
                  '@tailwind base;\n@tailwind components;\n@tailwind utilities;'
                );
                await writeFile(cssFile.path, fixed);
                log(`🔧 Post-start fix: converted Tailwind @import in ${cssFile.path}`);
              }
            }
            const postcssContent = `module.exports = {\n  plugins: {\n    '@tailwindcss/postcss': {},\n  },\n};`;
            const existingPcf = projectFiles.find(f =>
              f.path === 'postcss.config.js' || f.path === 'postcss.config.cjs' || f.path === 'postcss.config.mjs'
            );
            const pcfPath = existingPcf ? existingPcf.path : 'postcss.config.cjs';
            await writeFile(pcfPath, postcssContent);
            log(`🔧 Post-start fix: rewrote ${pcfPath}`);
          } catch (e) {
            runnerLog.warn('PostStartFix', `Failed to fix postcss: ${e}`);
          }
        };

        const postStartAutoFixBuffer: string[] = [];
        let postStartAutoFixInFlight: Promise<void> | null = null;
        const postStartAutoFixPendingFiles = new Set<string>();
        // Part C convergence guard: count parse-error reports per file in this
        // run and emit a single `runnerLog.warn` once we've seen ≥3 — that's
        // a strong signal a new typo family is slipping through both the
        // targeted handler and the whole-file drain.
        const postStartFileErrorCounts = new Map<string, number>();
        const postStartFileWarned = new Set<string>();
        const POST_START_RECURRENCE_THRESHOLD = 3;
        const postStartFixContext: AutoFixContext = {
          files: projectFiles,
          updateFile: async (path: string, content: string) => {
            await writeFile(path, content);
            const idx = projectFiles.findIndex(f => f.path === path);
            if (idx >= 0) {
              projectFiles[idx] = { ...projectFiles[idx], content };
            }
          },
          addTerminalLine: (_type: string, message: string) => log(message),
          retryCount: 0,
        };
        const runPostStartAutoFix = async (errorLine: string, candidatePath?: string): Promise<void> => {
          postStartAutoFixBuffer.push(errorLine);
          if (candidatePath) {
            postStartAutoFixPendingFiles.add(normalizeFixPath(candidatePath));
            const key = normalizeFixPath(candidatePath);
            const { count, shouldWarn } = recordRecurrenceAndShouldWarn(
              postStartFileErrorCounts,
              postStartFileWarned,
              key,
              POST_START_RECURRENCE_THRESHOLD,
            );
            if (shouldWarn) {
              const span = errorLine.length > 240 ? errorLine.slice(0, 240) + '…' : errorLine;
              runnerLog.warn(
                'PostStartAutoFix',
                `Convergence guard: ${candidatePath} has errored ${count} time(s) in this run. Triggering last-ditch whole-file drain. Last error: ${span}`,
              );
              log(`⚠️ Auto-fix not converging on ${candidatePath} (${count} errors). Running last-ditch drain...`);
              // Last-ditch trigger: run one more whole-file drain so any
              // typo family the targeted handler missed gets a final pass
              // before we declare failure. Fire-and-forget — the next
              // dev-server reload will surface the post-drain state.
              (async () => {
                try {
                  const fileContent = await readFile(candidatePath);
                  if (fileContent) {
                    const drained = drainKnownTypos(fileContent, candidatePath);
                    if (drained.content !== fileContent) {
                      await writeFile(candidatePath, drained.content);
                      const idx = projectFiles.findIndex(f => f.path === candidatePath);
                      if (idx >= 0) {
                        projectFiles[idx] = { ...projectFiles[idx], content: drained.content };
                      }
                      const summary = drained.fixesApplied
                        .map((f) => `${f.id}×${f.count}`)
                        .join(', ');
                      runnerLog.info('PostStartAutoFix', `Last-ditch drain: ${candidatePath} — ${summary}`);
                      log(`🧹 Last-ditch drain: ${candidatePath} — ${summary}`);
                      // Reset the recurrence counter so the next failure
                      // (if any) re-arms the guard rather than staying mute.
                      postStartFileErrorCounts.delete(key);
                      postStartFileWarned.delete(key);
                    } else {
                      log(`⚠️ Last-ditch drain found no known typos in ${candidatePath} — manual review may be needed.`);
                    }
                  }
                } catch (e) {
                  runnerLog.warn('PostStartAutoFix', `Last-ditch drain failed for ${candidatePath}: ${e}`);
                }
              })();
            }
          }
          if (postStartAutoFixInFlight) return postStartAutoFixInFlight;
          const drain = (async () => {
            try {
              while (postStartAutoFixBuffer.length > 0) {
                const line = postStartAutoFixBuffer.shift()!;
                try {
                  const res = await autoFixEngine.processError(line, postStartFixContext);
                  if (res?.fixed && res.codeChanges) {
                    for (const change of res.codeChanges) {
                      // After the targeted fix, sweep the whole file for any
                      // remaining known LLM-typo sites in one pass — without
                      // this, files with N typos cycle through N restarts.
                      const drained = drainKnownTypos(change.fixed, change.file);
                      const finalContent = drained.content;
                      await writeFile(change.file, finalContent);
                      const idx = projectFiles.findIndex(f => f.path === change.file);
                      if (idx >= 0) {
                        projectFiles[idx] = { ...projectFiles[idx], content: finalContent };
                      }
                      claimAstFix(change.file);
                      const fileKey = normalizeFixPath(change.file);
                      postStartAutoFixPendingFiles.delete(fileKey);
                      // A successful repair clears the recurrence counter so
                      // a later, unrelated typo in the same file gets a fresh
                      // budget before the warning fires again.
                      postStartFileErrorCounts.delete(fileKey);
                      postStartFileWarned.delete(fileKey);
                      if (drained.fixesApplied.length > 0) {
                        const summary = drained.fixesApplied
                          .map((f) => `${f.id}×${f.count}`)
                          .join(', ');
                        runnerLog.info('PostStartAutoFix', `Drain: ${change.file} — ${summary}`);
                        log(`🧹 Post-start drain: ${change.file} — ${summary}`);
                      }
                    }
                    runnerLog.info('PostStartAutoFix', `Applied: ${res.action}`);
                    log(`🔧 Post-start auto-fix: ${res.action}`);
                  }
                } catch (e) {
                  runnerLog.warn('PostStartAutoFix', `Handler failed: ${e}`);
                }
              }
            } finally {
              postStartAutoFixPendingFiles.clear();
              postStartAutoFixInFlight = null;
            }
          })();
          postStartAutoFixInFlight = drain;
          return drain;
        };
        const isAstFixPendingFor = (filePath: string): boolean =>
          postStartAutoFixPendingFiles.has(normalizeFixPath(filePath));

        const handlePostStartOutput = (output: string) => {
          const srcFileMatch = output.match(/\/?(src\/[^\s:]+\.[tj]sx?)/);
          const anyFileMatch = output.match(/\/?((?:src|lib|components|pages|app|utils|hooks)\/[^\s:]+\.[tj]sx?)/);
          const rootFileMatch = output.match(/(?:^|\s)\/?([\w.-]+\.[tj]sx?)(?::|\s)/);
          const pluginMatch = output.match(/\[plugin:vite:react-babel\]\s+\/?([\w./\\-]+\.[tj]sx?)/);
          const isParseError = isParseErrorOutput(output);
          const isPostcssError = (output.includes('postcss') && output.includes('Unknown word')) ||
            (output.includes('postcss') && output.includes('use strict'));

          if (isParseError) {
            const path = pluginMatch?.[1] || anyFileMatch?.[1] || srcFileMatch?.[1] || rootFileMatch?.[1];
            if (path && !path.includes('node_modules')) {
              (async () => {
                await runPostStartAutoFix(output, path);
                await fixFileFromError(path);
              })();
            }
          }
          if (isPostcssError) fixPostcssError();
        };

        // ── Pre-start whole-project drain ────────────────────────────────
        // Sweep every code file for known LLM typos BEFORE the dev server
        // boots. esbuild bails after a few errors per file so secondary
        // typos and typos in clean-on-scan files would otherwise survive
        // until Vite's pre-transform stage — at which point Vite has
        // already cached the broken transform and rewriting the file on
        // disk does NOT invalidate the cache (WebContainer's FS-watcher
        // signal isn't reliable inside Vite). Draining first means Vite
        // never sees a broken file and there's nothing stale to flush.
        try {
          const drainResult = await runWholeProjectDrain({
            files: projectFiles,
            read: (p) => readFile(p).catch(() => null),
            write: writeFile,
            drain: drainKnownTypos,
          });
          for (const t of drainResult.touched) {
            const idx = projectFiles.findIndex(p => p.path === t.path);
            if (idx >= 0) projectFiles[idx] = { ...projectFiles[idx], content: t.content };
          }
          if (drainResult.touched.length > 0) {
            const summary = Object.entries(drainResult.aggregate)
              .map(([id, count]) => `${id}×${count}`)
              .join(', ');
            runnerLog.info('PreStartDrain', `Pre-start drain repaired ${drainResult.touched.length} file(s): ${summary}`);
            log(`🧹 Pre-start whole-project drain: ${drainResult.touched.length} file(s) — ${summary}`);
          } else {
            runnerLog.debug('PreStartDrain', 'Pre-start drain: no known typos');
          }

          // Residual-broken-pattern audit: surface every known-broken shape
          // that survived the drain. This catches silent misses where the
          // drain ran on stale bytes or a typo escaped its regex (root
          // cause of the "drain logged 0 mangled-arrow but Vite errored"
          // failure mode). Each finding becomes a loud warning AND a
          // best-effort second-pass repair using the live in-memory copy.
          try {
            const findings = auditResidualBrokenPatterns(projectFiles);
            if (findings.length > 0) {
              const grouped: Record<string, ResidualFinding[]> = {};
              for (const f of findings) {
                (grouped[f.pattern] ??= []).push(f);
              }
              const summary = Object.entries(grouped)
                .map(([pat, hits]) => `${pat}×${hits.length}`)
                .join(', ');
              runnerLog.warn('PreStartDrain', `Residual broken patterns AFTER drain: ${summary}`);
              log(`⚠️ Drain silent-miss audit found residual broken patterns: ${summary}`);
              for (const f of findings.slice(0, 12)) {
                const msg = `   • ${f.pattern} in ${f.file}:${f.line} → ${f.snippet.trim()}`;
                runnerLog.warn('PreStartDrain', msg);
                log(msg);
              }
              // Second-pass repair: re-read each file fresh from disk so we
              // never overwrite newer content with stale in-memory bytes.
              // Only write back when (a) drain mutates the fresh content AND
              // (b) the residual broken pattern is actually present on disk.
              const reRepaired: string[] = [];
              const auditedPaths = Array.from(new Set(findings.map(f => f.file)));
              for (const filePath of auditedPaths) {
                let fresh: string | null = null;
                try { fresh = await readFile(filePath); } catch { fresh = null; }
                const idx = projectFiles.findIndex(p => p.path === filePath);
                if (fresh === null) continue; // disk read failed → skip, don't overwrite
                // Verify a residual finding is still in fresh disk content
                // (guards against a race where another writer cleaned it).
                const stillBroken = auditResidualBrokenPatterns([{ path: filePath, content: fresh }]);
                if (stillBroken.length === 0) continue;
                const after = drainKnownTypos(fresh, filePath).content;
                if (after !== fresh) {
                  await writeFile(filePath, after);
                  if (idx >= 0) projectFiles[idx] = { ...projectFiles[idx], content: after };
                  reRepaired.push(filePath);
                }
              }
              if (reRepaired.length > 0) {
                const uniq = Array.from(new Set(reRepaired));
                runnerLog.info('PreStartDrain', `Second-pass drain repaired ${uniq.length} file(s) in-memory`);
                log(`🔁 Second-pass drain (in-memory): ${uniq.length} file(s)`);
              }
            }
          } catch (auditErr) {
            runnerLog.warn('PreStartDrain', `Residual audit failed: ${auditErr}`);
          }

          // ── Three-layer cascade (parser-gate → SLM repair → template floor) ──
          // Runs BEFORE the esbuild verify-gate so generative repair gets a
          // shot before the regex treadmill. Falls through harmlessly if the
          // local model is unavailable (api-server returns 503; cascade then
          // leaves files as-is for the existing engine). Gated on
          // VITE_THREE_LAYER_CASCADE !== '0' so it can be quickly disabled.
          const cascadeEnabled =
            (import.meta as unknown as { env?: Record<string, string | undefined> })
              .env?.VITE_THREE_LAYER_CASCADE !== '0';
          // Task #23 — single repair-branch host shared between the
          // three-layer cascade and the verify-then-start gate. Both
          // sites push audit entries here; the host enforces no-nested-
          // branches across both call sites. We log a one-line rollup
          // after the gate completes.
          const repairBranchHost: import('./repair-branch').RunnerBranchHost = {};
          if (cascadeEnabled) {
            try {
              // Scaffold-lookup wired to the pre-cascade snapshot of
              // projectFiles so the basement can recover from a known-
              // good copy when later stages corrupt a file. (When a true
              // template registry is plumbed through, swap this for a
              // lookup against the original scaffold files.)
              const scaffoldSnapshot = new Map<string, string>(
                projectFiles.map((f) => [f.path, f.content]),
              );
              // The cascade sees ALL files (including tests/stories) so
              // they get the same parser-gate → SLM → basement treatment
              // any other file would. The verify-gate then decides
              // (via the criticality classifier) which still-broken files
              // can be stubbed and which abort startup. We deliberately
              // do NOT pre-filter here — the spec requires honest
              // degraded-mode reporting for broken non-runtime files,
              // not silent skipping.
              const cascade = await runThreeLayerCascade(projectFiles, {
                write: writeFile,
                // Task #23 — forward the FS delete so branch discard
                // achieves true snapshot parity for created files.
                del: async (p) => { await tryRemoveFile(p); },
                log: (m) => runnerLog.debug('Cascade', m),
                scaffoldLookup: (p) => scaffoldSnapshot.get(p) ?? null,
                gatePassBudgetMs: 30_000,
                branchHost: repairBranchHost,
              });
              if (cascade.rewrittenPaths.length > 0) {
                log(`🛠 Three-layer cascade rewrote ${cascade.rewrittenPaths.length} file(s)`);
                for (const p of cascade.rewrittenPaths) {
                  try {
                    const fresh = await readFile(p);
                    if (typeof fresh !== 'string') continue;
                    const idx = projectFiles.findIndex((f) => f.path === p);
                    if (idx >= 0) projectFiles[idx] = { ...projectFiles[idx], content: fresh };
                  } catch (e) {
                    runnerLog.debug('Cascade', `re-read after rewrite failed for ${p}: ${e}`);
                  }
                }
              }
              for (const b of cascade.banners) {
                // Phrase the banner honestly: distinguish "the safety net
                // engaged because the SLM was unreachable" from "the
                // template-basement reset a file it could not fix". The
                // friendly slmReason is already prefixed in the cascade,
                // so we just check for it here.
                if (/^slm-repair unavailable/i.test(b.reason) || /recovered-from-scaffold:.*slm-repair unavailable/i.test(b.reason)) {
                  log(`⚠️ ${b.path} stubbed — slm-repair unavailable, fell back to template-basement`);
                } else {
                  log(`⚠️ ${b.path} reset by template-basement: ${b.reason}`);
                }
              }
              for (const r of cascade.perFile) {
                if (r.action === 'slm-repaired') {
                  runnerLog.info('Cascade', `SLM repaired ${r.path}: ${r.banner}`);
                } else if (r.action === 'template-substituted') {
                  runnerLog.warn('Cascade', `Template stub for ${r.path}: ${r.banner}`);
                }
              }
            } catch (cascadeErr) {
              runnerLog.warn('Cascade', `three-layer cascade failed: ${cascadeErr}`);
            }
          }

          // ── Verify-then-start gate ──────────────────────────────────────
          // Parse-check every code file with esbuild-wasm BEFORE Vite boots.
          // Cascade-suppressed: one error per file per iteration → drain
          // → re-parse, up to 3 rounds. If files remain broken after all
          // iterations, ABORT before startDevServer — we never hand Vite
          // a known-broken tree (it would cache the bad transform and the
          // user would never see a clean run).
          //
          // Skipping the gate is allowed only if esbuild-wasm cannot be
          // loaded at all (older runtimes); in that case a debug-level
          // log is emitted and the prior drain/audit layers remain.
          let gateAborted = false;
          let gateAbortMessage = '';
          // Fail-closed policy: if esbuild-wasm cannot load/init, abort
          // startup unless an opt-out flag is set (e.g. dev-only escape
          // hatch). Reads from VITE_VERIFY_GATE_ALLOW_SKIP === '1'.
          const allowSkipOnGateFailure =
            (import.meta as unknown as { env?: Record<string, string | undefined> })
              .env?.VITE_VERIFY_GATE_ALLOW_SKIP === '1';
          let gateInfraFailed = false;
          let gateInfraReason = '';
          try {
            type EsbuildLike = {
              transform: (s: string, o: { loader?: 'ts'|'tsx'|'js'|'jsx'; sourcefile?: string }) => Promise<unknown>;
              initialize?: (o: { wasmURL?: string; worker?: boolean }) => Promise<void>;
            };
            let esb: EsbuildLike | null = null;
            try {
              // Static dynamic import so Vite pre-bundles esbuild-wasm
              // for the browser. The package MUST be installed in the
              // host node_modules (pnpm install). If unavailable, the
              // catch below triggers the fail-closed branch.
              const mod = await import('esbuild-wasm');
              if (mod && typeof (mod as unknown as EsbuildLike).transform === 'function') {
                esb = mod as unknown as EsbuildLike;
              } else {
                gateInfraFailed = true;
                gateInfraReason = 'esbuild-wasm module loaded but missing transform()';
              }
            } catch (importErr) {
              gateInfraFailed = true;
              gateInfraReason = `esbuild-wasm import failed: ${importErr}`;
              runnerLog.warn('VerifyGate', gateInfraReason);
            }
            if (esb) {
              if (typeof esb.initialize === 'function') {
                try {
                  await esb.initialize({ wasmURL: '/node_modules/esbuild-wasm/esbuild.wasm', worker: false });
                } catch (initErr) {
                  // Already-initialized throws — that's fine; anything
                  // else means the wasm bootstrap is broken.
                  const msg = String(initErr);
                  if (!/already.*initialized|already started/i.test(msg)) {
                    gateInfraFailed = true;
                    gateInfraReason = `esbuild initialize failed: ${msg}`;
                    runnerLog.warn('VerifyGate', gateInfraReason);
                  }
                }
              }
              // If init flagged a real failure, treat the gate as down.
              if (gateInfraFailed) esb = null;
            }
            if (esb) {
              // The verify-gate parse-checks ALL files (tests/stories
              // included). The criticality classifier handles the
              // partition: broken tests → stubbed in degraded mode;
              // broken runtime files → hard abort. This is honest
              // reporting per spec — silently skipping broken tests
              // would let bugs hide.
              const verify = await runVerifyThenStartGate({
                files: projectFiles,
                transform: esb.transform,
                read: (p) => readFile(p).catch(() => null),
                write: writeFile,
                // Task #23 — forward FS delete so branch discard removes
                // paths CREATED inside the iteration (no baseline) for
                // true snapshot parity with the pre-iteration FS.
                del: async (p) => { await tryRemoveFile(p); },
                drain: drainKnownTypos,
                maxIterations: 3,
                branchHost: repairBranchHost,
                // Run the doctor inside the gate loop so any vite/vitest
                // config repair (e.g. `defineConfig() {` → `defineConfig({`)
                // happens before the parse-check, even if the file wasn't
                // present during the startup pass at line ~1672.
                doctor: (files) => {
                  const report = runViteTailwindDoctor({ files }, 'runtime');
                  return report.codeChanges.map((c) => ({ file: c.file, fixed: c.fixed }));
                },
                // Stub-on-stagnation: when the repair loop can't converge
                // on a non-critical file, swap in a minimal valid stub via
                // template-basement so the app boots in degraded mode
                // instead of dying outright. Critical files (entry HTML,
                // vite config, root App, server) keep the existing abort.
                criticalityClassifier: classifyFileCriticality,
                stubGenerator: (path, reason) => {
                  const s = generateStub(path, reason);
                  return { substituted: s.substituted, content: s.content };
                },
              });
              // Sync repaired content back into projectFiles so downstream
              // stages see canonical bytes, not stale snapshots.
              for (const p of verify.repairedFiles) {
                try {
                  const fresh = await readFile(p);
                  if (typeof fresh !== 'string') continue;
                  const idx = projectFiles.findIndex(f => f.path === p);
                  if (idx >= 0) {
                    projectFiles[idx] = { ...projectFiles[idx], content: fresh };
                  }
                } catch (rereadErr) {
                  runnerLog.debug('VerifyGate', `Re-read after repair failed for ${p}: ${rereadErr}`);
                }
              }
              const iterSummary = verify.perIteration
                .map(s => `i${s.iteration}:${s.errorCount}err→${s.repairedCount}fix`)
                .join(' ');
              // Per-iteration cascade diagnostics: log the per-file action map
              // so future stalls show *which* files refused to repair.
              for (const it of verify.perIteration) {
                const entries = Object.entries(it.perFileActions);
                if (entries.length === 0) continue;
                const fixed = entries.filter(([, a]) => a === 'fixed').map(([p]) => p);
                const unchanged = entries.filter(([, a]) => a === 'unchanged').map(([p]) => p);
                const newErrs = entries.filter(([, a]) => a === 'new-error').map(([p]) => p);
                const parts: string[] = [];
                if (fixed.length) parts.push(`fixed=${fixed.length}`);
                if (unchanged.length) parts.push(`unchanged=${unchanged.length}`);
                if (newErrs.length) parts.push(`new-error=${newErrs.length}`);
                runnerLog.debug(
                  'VerifyGate',
                  `iter ${it.iteration} actions [${parts.join(', ')}]`,
                );
                for (const p of unchanged) {
                  runnerLog.debug('VerifyGate', `  • unchanged: ${p}`);
                }
                for (const p of newErrs) {
                  runnerLog.debug('VerifyGate', `  • new-error: ${p}`);
                }
              }
              // Task #23 — surface a one-line repair-branch rollup right
              // after the verify gate so the audit trail (committed vs
              // discarded across cascade + gate) is visible in the chat.
              try {
                const rb = await import('./repair-branch');
                const audit = repairBranchHost.repairAudit ?? [];
                if (audit.length > 0) {
                  log(`🌿 ${rb.summarizeRunnerRepairAudit(audit)}`);
                }
              } catch (e) {
                runnerLog.debug('RepairBranch', `audit summary failed: ${e}`);
              }
              if (verify.ok) {
                runnerLog.info('VerifyGate', `Pre-start parse gate clean after ${verify.iterations} iter(s) [${iterSummary}]`);
                if (verify.repairedFiles.length > 0) {
                  log(`✅ Verify-then-start gate: clean after ${verify.iterations} iter, repaired ${verify.repairedFiles.length} file(s)`);
                }
                // Degraded-mode banner: emit the spec-required warning
                // line FIRST (so it appears at startup), then the
                // 🚦 summary + per-file detail lines.
                if (verify.degradedMode && verify.stubbedFiles && verify.stubbedFiles.length > 0) {
                  const list = verify.stubbedFiles.map(s => s.path).join(', ');
                  log(`⚠️ Started in degraded mode — ${verify.stubbedFiles.length} non-critical file(s) stubbed: ${list}`);
                  log(`🚦 App is live but in degraded mode: ${verify.stubbedFiles.length} file(s) stubbed (${list}). Re-run or hand-edit to restore.`);
                  for (const s of verify.stubbedFiles) {
                    log(`   • ${s.path} — ${s.criticalityReason}; stubbed because: ${s.reason}`);
                    runnerLog.warn('VerifyGate', `Stubbed non-critical file ${s.path}: ${s.reason}`);
                  }
                }
              } else {
                // Hard abort — do NOT start Vite on a broken tree.
                gateAborted = true;
                // Plain-language one-liner so the user sees WHAT is broken
                // before the technical iteration summary.
                const brokenPaths = Array.from(new Set(verify.stillBroken.map(e => e.file)));
                const criticalPaths = brokenPaths.filter(p => classifyFileCriticality(p).critical);
                const nonCriticalPaths = brokenPaths.filter(p => !classifyFileCriticality(p).critical);
                const lines: string[] = [];
                if (criticalPaths.length > 0) {
                  // Real critical-file abort.
                  const criticalList = criticalPaths.slice(0, 6).join(', ');
                  lines.push(`❌ Cannot start: ${criticalPaths.length} critical file(s) won't parse. The app needs ${criticalList} to boot. Re-run generation or hand-edit those files.`);
                } else {
                  // No critical files broken — abort came because the
                  // stub-on-stagnation escalation could not produce a
                  // valid stub for one or more non-critical files (e.g.
                  // generateStub returned substituted=false, or the
                  // re-verify caught a malformed stub). Be honest about
                  // what failed instead of mis-labeling them critical.
                  const list = nonCriticalPaths.slice(0, 6).join(', ');
                  lines.push(`❌ Cannot start: ${nonCriticalPaths.length} non-critical file(s) won't parse and could not be stubbed safely (${list}). Re-run generation or hand-edit those files.`);
                }
                lines.push(`❌ Verify-then-start gate ABORTED startup: ${verify.stillBroken.length} file(s) still broken after ${verify.iterations} iteration(s) [${iterSummary}]`);
                if (verify.stubbedFiles && verify.stubbedFiles.length > 0) {
                  // Some non-critical files were stubbed during the
                  // escalation but the abort came from a critical file
                  // — surface that nuance.
                  lines.push(`   (${verify.stubbedFiles.length} non-critical file(s) were stubbed but a critical file is still broken — abort stands.)`);
                }
                // Aggregate per-file action counts across all iterations
                // and surface them in the user-visible abort summary so
                // operators can see which files refused to converge.
                const totals: Record<string, number> = { fixed: 0, unchanged: 0, 'new-error': 0 };
                const lastUnchanged = new Set<string>();
                const lastNewError = new Set<string>();
                for (const it of verify.perIteration) {
                  for (const [p, a] of Object.entries(it.perFileActions)) {
                    totals[a] = (totals[a] ?? 0) + 1;
                  }
                }
                const lastIt = verify.perIteration[verify.perIteration.length - 1];
                if (lastIt) {
                  for (const [p, a] of Object.entries(lastIt.perFileActions)) {
                    if (a === 'unchanged') lastUnchanged.add(p);
                    else if (a === 'new-error') lastNewError.add(p);
                  }
                }
                lines.push(
                  `   actions across iterations: fixed=${totals.fixed}, unchanged=${totals.unchanged}, new-error=${totals['new-error']}`,
                );
                for (const p of Array.from(lastUnchanged).slice(0, 6)) {
                  lines.push(`   • unchanged: ${p}`);
                }
                for (const p of Array.from(lastNewError).slice(0, 6)) {
                  lines.push(`   • new-error: ${p}`);
                }
                for (const e of verify.stillBroken.slice(0, 12)) {
                  lines.push(`   • still-broken: ${e.file}:${e.line}:${e.column} — ${e.message}`);
                }
                if (verify.stillBroken.length > 12) {
                  lines.push(`   • …and ${verify.stillBroken.length - 12} more`);
                }

                // ──────────────────────────────────────────────────────
                // Self-capture: dump every still-broken file's current
                // bytes to disk via the local api-server. Detached as a
                // background task so it CANNOT block the abort return —
                // a hung api-server, a slow fetch, or a DNS hiccup will
                // never stall the user. Capture result lands in the log
                // a moment after abort, which is fine; the bytes-on-disk
                // is what matters.
                // ──────────────────────────────────────────────────────
                const stillBrokenSnapshot = verify.stillBroken.slice();
                const stillBrokenPaths = Array.from(
                  new Set(stillBrokenSnapshot.map(e => e.file)),
                );
                lines.push(
                  `   📦 Capturing ${stillBrokenPaths.length} broken file(s) to disk via api-server (background)…`,
                );
                void (async () => {
                  try {
                    const fileBundle: { path: string; content: string }[] = [];
                    for (const p of stillBrokenPaths) {
                      let content: string | null = null;
                      try { content = await readFile(p); } catch { content = null; }
                      if (typeof content !== 'string') {
                        const inMem = projectFiles.find(f => f.path === p);
                        content = inMem?.content ?? '';
                      }
                      fileBundle.push({ path: p, content });
                    }
                    const apiBaseRaw =
                      (import.meta as unknown as { env?: Record<string, string> }).env
                        ?.VITE_API_BASE ?? '';
                    const apiBase = apiBaseRaw.replace(/\/+$/, '');
                    const captureUrl = `${apiBase}/api/diagnostics/capture-failure`;
                    const ctl = new AbortController();
                    const timer = setTimeout(() => ctl.abort(), 5000);
                    try {
                      const resp = await fetch(captureUrl, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                          label: 'verify-gate-abort',
                          files: fileBundle,
                          errors: stillBrokenSnapshot,
                        }),
                        signal: ctl.signal,
                      });
                      if (resp.ok) {
                        const body = (await resp.json().catch(() => null)) as
                          | { capturedDir?: string; fileCount?: number }
                          | null;
                        const where = body?.capturedDir ?? '(unknown path)';
                        const nFiles = body?.fileCount ?? fileBundle.length;
                        // Spec line: `📦 Captured failure to <path>`.
                        // We also append (Nfiles) for diagnostic value.
                        const captureLine = `📦 Captured failure to ${where} (${nFiles} file(s))`;
                        runnerLog.info('VerifyGate', captureLine);
                        try { log(captureLine); } catch { /* logger may be detached after return */ }
                      } else {
                        const captureLine = `⚠️ Capture endpoint returned ${resp.status} — no fixture saved (is the api-server running on ${apiBase}?)`;
                        runnerLog.warn('VerifyGate', captureLine);
                        try { log(captureLine); } catch { /* noop */ }
                      }
                    } finally {
                      clearTimeout(timer);
                    }
                  } catch (captureErr) {
                    const captureLine = `⚠️ Could not POST capture bundle to api-server: ${captureErr}`;
                    runnerLog.warn('VerifyGate', captureLine);
                    try { log(captureLine); } catch { /* noop */ }
                  }
                })();

                gateAbortMessage = lines.join('\n');
                for (const ln of lines) {
                  runnerLog.error('VerifyGate', ln);
                  log(ln);
                }
              }
            } else if (gateInfraFailed && !allowSkipOnGateFailure) {
              // Fail-closed: bootstrap broken AND no opt-out → abort.
              gateAborted = true;
              gateAbortMessage =
                `Verify-then-start gate could not initialize and is required to be active. ${gateInfraReason}\n` +
                `Set VITE_VERIFY_GATE_ALLOW_SKIP=1 to bypass (development only).`;
              runnerLog.error('VerifyGate', `Aborting: ${gateInfraReason}`);
              log(`❌ Verify-then-start gate could not initialize — aborting before Vite boot. ${gateInfraReason}`);
            } else if (gateInfraFailed) {
              runnerLog.warn('VerifyGate', `esbuild-wasm unavailable AND opt-out flag set — proceeding without parse gate. ${gateInfraReason}`);
              log(`⚠️ Verify-then-start gate skipped via VITE_VERIFY_GATE_ALLOW_SKIP. ${gateInfraReason}`);
            } else {
              runnerLog.debug('VerifyGate', 'esbuild-wasm not available — skipping verify-then-start gate');
            }
          } catch (verifyErr) {
            runnerLog.warn('VerifyGate', `Verify-then-start gate failed: ${verifyErr}`);
          }
          if (gateAborted) {
            // Bubble up as an early return — caller surfaces this to UI
            // exactly like a Vite startup failure, but without ever
            // starting Vite (so no cached bad transforms).
            return {
              success: false,
              previewUrl: null,
              error: `Verify-then-start gate aborted: project still has unrecoverable syntax errors after pre-start drain.\n${gateAbortMessage}`,
            };
          }
        } catch (drainErr) {
          runnerLog.warn('PreStartDrain', `Pre-start drain failed: ${drainErr}`);
        }

        const result = await startDevServer(
          (output) => {
            errorCollector(output);
            if (output.includes('Unknown node type') || output.includes('unknown node type') ||
                (output.includes('Cannot read properties of undefined') && output.includes('vite'))) {
              postStartErrors.push(output);
            }
            handlePostStartOutput(output);
          },
          (serverUrl) => {
            log(`✅ Server ready at ${serverUrl}`);
            callbacks.onPreviewReady?.(serverUrl);
          }
        );
        url = result.url;

        // Fix 3 — Console Error Capture: collect runtime errors forwarded by
        // the in-container shim (see ensureErrorCaptureShim in webcontainer.ts)
        // for 10 s after the dev server becomes ready. If any arrive, route
        // them through /api/auto-fix as a fourth error class (errorType:
        // 'runtime') so silent app crashes trigger the same repair pipeline.
        const runtimeErrors: Array<{ message: string; stack?: string; file?: string; line?: number }> = [];
        const runtimeErrorListener = (ev: MessageEvent) => {
          const data = ev?.data;
          if (!data || typeof data !== 'object' || data.type !== 'wc-console-error') return;
          if (typeof data.message !== 'string' || data.message.length === 0) return;
          // Cap collection size to avoid unbounded growth on a noisy app.
          if (runtimeErrors.length >= 50) return;
          runtimeErrors.push({
            message: data.message.slice(0, 1000),
            stack: typeof data.stack === 'string' ? data.stack.slice(0, 2000) : undefined,
            file: typeof data.file === 'string' ? data.file : undefined,
            line: typeof data.line === 'number' ? data.line : undefined,
          });
        };
        if (typeof window !== 'undefined') {
          window.addEventListener('message', runtimeErrorListener);
          // Drain the 10 s collection window asynchronously. Detached from the
          // pipeline so it cannot delay the preview going live; any errors
          // captured trigger /api/auto-fix in the background. Snapshot
          // projectFiles at firing time so a later mutation can't poison it.
          // Snapshot the run id so a delayed callback from a previous run
          // can't bleed user-visible logs/onError into a newer run that the
          // user has since started.
          const callbackRunId = runId;
          setTimeout(async () => {
            try { window.removeEventListener('message', runtimeErrorListener); } catch {}
            if (runtimeErrors.length === 0) return;
            if (activeRunId !== callbackRunId) {
              runnerLog.debug('AutoRunner', `Skipping stale runtime-error callback (run ${callbackRunId} superseded by ${activeRunId})`);
              return;
            }
            runnerLog.warn('AutoRunner', `Captured ${runtimeErrors.length} runtime error(s) from preview iframe — invoking /api/auto-fix (errorType: runtime)`);
            const topErr = runtimeErrors[0];
            const topLoc = topErr.file ? ` (${topErr.file}${typeof topErr.line === 'number' ? ':' + topErr.line : ''})` : '';
            log(`⚠️ App started but crashed at runtime — ${runtimeErrors.length} error(s) captured from the preview iframe.`);
            log(`   Top error${topLoc}: ${topErr.message}`);
            log(`🩺 Asking the server for repair patches...`);
            // /api/auto-fix expects `errors: string[]` (parseErrors operates on
            // raw error message strings — see vite-error-fixer.ts). Flatten the
            // captured object payloads into the same line shape Vite produces
            // ("file:line: message") so the existing parser/fixer pipeline can
            // process them without a route-side schema change.
            const errorStrings = runtimeErrors.map(e => {
              const loc = e.file ? ` ${e.file}${typeof e.line === 'number' ? `:${e.line}` : ''}` : '';
              const stack = e.stack ? `\n${e.stack}` : '';
              return `[runtime]${loc} ${e.message}${stack}`;
            });
            // Be honest about the outcome: inspect the auto-fix response and
            // surface a clear "can or cannot repair" message instead of
            // silently throwing the response away (which is what the previous
            // fire-and-forget version did, leaving the user staring at a
            // "Application running" toast over a broken iframe).
            try {
              const resp = await fetch('/api/auto-fix', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  errorType: 'runtime',
                  errors: errorStrings,
                  files: projectFiles.map(f => ({ path: f.path, content: f.content, language: f.path.split('.').pop() || '' })),
                }),
              });
              if (!resp.ok) {
                runnerLog.warn('AutoRunner', `Runtime auto-fix HTTP ${resp.status}`);
                log(`❌ Auto-fix server returned HTTP ${resp.status} — cannot repair runtime crash.`);
                log(`   The preview is live at ${url}, but the app is broken. Reason: ${topErr.message}`);
                callbacks.onError?.(`App crashed at runtime, server returned HTTP ${resp.status}: ${topErr.message}`);
                return;
              }
              let payload: any = null;
              try { payload = await resp.json(); } catch { payload = null; }
              const fixCount = Array.isArray(payload?.fixes) ? payload.fixes.length : 0;
              if (fixCount === 0) {
                runnerLog.warn('AutoRunner', 'Auto-fix returned 0 repairs for runtime errors');
                log(`❌ Auto-fix has no repair for this runtime crash.`);
                log(`   The preview is live at ${url}, but the app is broken. Reason: ${topErr.message}`);
                log(`   Cannot debug or repair this automatically — manual review of the generated code is required.`);
                callbacks.onError?.(`App crashed at runtime, auto-fix has no repair: ${topErr.message}`);
                return;
              }
              log(`📦 Auto-fix server proposed ${fixCount} repair patch(es) for the runtime crash, but they are NOT applied automatically on this path.`);
              log(`   The preview is live at ${url} but still broken. Re-run the project to apply the proposed repairs. Top error: ${topErr.message}`);
              runnerLog.info('AutoRunner', `Auto-fix returned ${fixCount} repair(s); not applied on the runtime path — user must re-run`);
              callbacks.onError?.(`App crashed at runtime; ${fixCount} repair(s) suggested but not applied — re-run to retry. Reason: ${topErr.message}`);
            } catch (err) {
              runnerLog.debug('AutoRunner', `Runtime auto-fix request failed: ${err}`);
              log(`❌ Auto-fix server unreachable — cannot repair runtime crash.`);
              log(`   The preview is live at ${url}, but the app is broken. Reason: ${topErr.message}`);
              callbacks.onError?.(`App crashed at runtime, auto-fix server unreachable: ${topErr.message}`);
            }
          }, 10000);
        }

        await new Promise(r => setTimeout(r, 4000));

        if (postStartErrors.length > 0) {
          runnerLog.warn('Pipeline', `Detected ${postStartErrors.length} Vite import-analysis errors after dev server start — patching and restarting`);
          log('⚠️ Vite import-analysis errors detected. Auto-fixing Rollup/Vite compatibility...');

          await patchRollupParseAstForWebContainer(readFile, writeFile, runnerLog);
          await patchViteChunkForWebContainer(readFile, writeFile, runnerLog);
          await killDevServer();
          await new Promise(r => setTimeout(r, 1500));

          const result2 = await startDevServer(
            (output) => {
              errorCollector(output);
              handlePostStartOutput(output);
            },
            (serverUrl) => {
              log(`✅ Server re-started at ${serverUrl}`);
              callbacks.onPreviewReady?.(serverUrl);
            }
          );
          url = result2.url;
          runnerLog.success('Pipeline', 'Dev server restarted after Rollup/Vite patch');
          log('✅ Dev server restarted successfully after Rollup/Vite fix');
        }

        // The whole-project drain now runs BEFORE startDevServer above, so
        // Vite never caches a broken transform. Live per-error fixes during
        // dev server runtime continue to handle anything novel.

        devServerStarted = true;
      } catch (devErr) {
        const devErrorMsg = devErr instanceof Error ? devErr.message : String(devErr);
        errorLines.push(devErrorMsg);

        fixAttempt++;
        if (fixAttempt >= maxFixAttempts) {
          throw devErr;
        }
        runnerLog.warn('Pipeline', `Dev server failed (attempt ${fixAttempt}/${maxFixAttempts}), attempting auto-fix...`);
        log(`⚠️ Dev server error, attempting auto-fix (${fixAttempt}/${maxFixAttempts})...`);

        const fixContext: AutoFixContext = {
          files: projectFiles,
          updateFile: async (path: string, content: string) => {
            await writeFile(path, content);
            const idx = projectFiles.findIndex(f => f.path === path);
            if (idx >= 0) {
              projectFiles[idx] = { ...projectFiles[idx], content };
            }
          },
          addTerminalLine: (_type: string, message: string) => log(message),
          retryCount: fixAttempt,
        };

        let fixApplied = false;
        let needsFullReinstall = false;
        for (const errorLine of errorLines) {
          const fixResult = await autoFixEngine.processError(errorLine, fixContext);
          if (fixResult?.fixed) {
            if (fixResult.needsFullReinstall) {
              needsFullReinstall = true;
              fixApplied = true;
              runnerLog.info('AutoFix', `Applied fix: ${fixResult.action}`);
              log(`🔧 Auto-fix: ${fixResult.action}`);
              break;
            }
            if (fixResult.codeChanges) {
              let viteConfigChanged = false;
              for (const change of fixResult.codeChanges) {
                // Drain the whole file for any further known typo sites so a
                // single dev-server restart resolves all defects in one pass.
                const drained = drainKnownTypos(change.fixed, change.file);
                const finalContent = drained.content;
                await writeFile(change.file, finalContent);
                const idx = projectFiles.findIndex(f => f.path === change.file);
                if (idx >= 0) {
                  projectFiles[idx] = { ...projectFiles[idx], content: finalContent };
                }
                if (drained.fixesApplied.length > 0) {
                  const summary = drained.fixesApplied
                    .map((f) => `${f.id}×${f.count}`)
                    .join(', ');
                  runnerLog.info('AutoFix', `Drain: ${change.file} — ${summary}`);
                  log(`🧹 Auto-fix drain: ${change.file} — ${summary}`);
                }
                if (change.file === 'package.json' || change.file.endsWith('/package.json')) {
                  needsReinstall = true;
                }
                if (change.file === 'vite.config.ts' || change.file === 'vite.config.js') {
                  viteConfigChanged = true;
                }
              }
              if (viteConfigChanged) {
                try {
                  const container = await getWebContainer();
                  await container.fs.rm('node_modules/.vite', { recursive: true });
                  runnerLog.info('AutoFix', 'Cleared Vite dep cache after config rewrite');
                } catch (_) {}
              }
              fixApplied = true;
              runnerLog.info('AutoFix', `Applied fix: ${fixResult.action}`);
              log(`🔧 Auto-fix: ${fixResult.action}`);
            }
          }
        }

        if (needsFullReinstall) {
          log('📦 Corrupted package detected — running full npm install to repair...');
          runnerLog.info('AutoFix', 'Triggering full npm install due to corrupted node_modules');
          await runNpmInstall([], true, (output) => log(output));
          await installWasmFallbacks((out) => log(out), runnerLog, readFile);
          await patchRollupNativeForWebContainer(readFile, writeFile, runnerLog);
          await patchEsbuildForWebContainer(readFile, writeFile, runnerLog);
          await patchEsbuildWasmBrowserJs(readFile, writeFile, runnerLog);
          needsReinstall = false;
          errorLines.length = 0;
          updateState({ progress: 80 + fixAttempt * 3, message: `Reinstalled packages, retrying (${fixAttempt}/${maxFixAttempts})...` });
          continue;
        }

        if (!fixApplied) {
          try {
            const resp = await fetch('/api/auto-fix', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                errors: errorLines,
                files: projectFiles.map(f => ({ path: f.path, content: f.content, language: f.path.split('.').pop() || '' })),
              }),
            });
            const serverFixes = await resp.json();
            if (serverFixes?.fixes?.length > 0) {
              for (const fix of serverFixes.fixes) {
                if (fix.type === 'patch_file' && fix.filePath && fix.newContent) {
                  const existing = projectFiles.find(f => f.path === fix.filePath);
                  if (existing && fix.oldContent) {
                    const patched = existing.content.replace(fix.oldContent, fix.newContent);
                    await writeFile(fix.filePath, patched);
                    existing.content = patched;
                    fixApplied = true;
                    if (fix.filePath === 'package.json') needsReinstall = true;
                    log(`🔧 Server fix (patch): ${fix.description || fix.filePath}`);
                  }
                } else if (fix.type === 'create_file' && fix.filePath && fix.newContent) {
                  await writeFile(fix.filePath, fix.newContent);
                  projectFiles.push({ path: fix.filePath, content: fix.newContent });
                  fixApplied = true;
                  log(`🔧 Server fix (create): ${fix.description || fix.filePath}`);
                } else if (fix.type === 'reinstall') {
                  needsFullReinstall = true;
                  fixApplied = true;
                  log(`🔧 Server fix: ${fix.description || 'Full reinstall needed'}`);
                  break;
                } else if (fix.type === 'add_dependency' && fix.packageName) {
                  const pkgIdx = projectFiles.findIndex(f => f.path === 'package.json');
                  if (pkgIdx >= 0) {
                    try {
                      const pkg = JSON.parse(projectFiles[pkgIdx].content);
                      const depKey = fix.isDev ? 'devDependencies' : 'dependencies';
                      pkg[depKey] = pkg[depKey] || {};
                      pkg[depKey][fix.packageName] = fix.packageVersion || 'latest';
                      const updated = JSON.stringify(pkg, null, 2);
                      await writeFile('package.json', updated);
                      projectFiles[pkgIdx] = { ...projectFiles[pkgIdx], content: updated };
                      needsReinstall = true;
                      fixApplied = true;
                      log(`🔧 Server fix (dep): added ${fix.packageName}@${fix.packageVersion || 'latest'} to ${depKey}`);
                    } catch (err) {
                      runnerLog.warn('AutoFix', `Failed to parse package.json for dependency addition: ${err}`);
                    }
                  }
                }
              }
            }
          } catch (fetchErr) {
            runnerLog.debug('AutoFix', `Server auto-fix request failed: ${fetchErr}`);
          }
        }

        if (needsFullReinstall) {
          log('📦 Corrupted package detected — running full npm install to repair...');
          runnerLog.info('AutoFix', 'Triggering full npm install due to corrupted node_modules (from server fix)');
          await runNpmInstall([], true, (output) => log(output));
          await installWasmFallbacks((out) => log(out), runnerLog, readFile);
          await patchRollupNativeForWebContainer(readFile, writeFile, runnerLog);
          await patchEsbuildForWebContainer(readFile, writeFile, runnerLog);
          await patchEsbuildWasmBrowserJs(readFile, writeFile, runnerLog);
          needsReinstall = false;
          errorLines.length = 0;
          updateState({ progress: 80 + fixAttempt * 3, message: `Reinstalled packages, retrying (${fixAttempt}/${maxFixAttempts})...` });
          continue;
        }

        if (needsReinstall) {
          log('📦 Re-installing dependencies after package.json fix...');
          await runNpmInstall([], false, (output) => log(output));
          await installWasmFallbacks((out) => log(out), runnerLog, readFile);
          await patchRollupNativeForWebContainer(readFile, writeFile, runnerLog);
          await patchEsbuildForWebContainer(readFile, writeFile, runnerLog);
          await patchEsbuildWasmBrowserJs(readFile, writeFile, runnerLog);
          needsReinstall = false;
        }

        if (!fixApplied) {
          runnerLog.warn('AutoFix', 'No fixes could be applied, retrying as-is...');
        }

        // Whole-project drain pass on the dev-server-failed retry path —
        // mirrors the post-success final pass so secondary typos in files
        // that the per-error fix loop didn't touch are repaired before the
        // next dev-server start. Mirrors task #14 step 3.
        try {
          const result = await runWholeProjectDrain({
            files: projectFiles,
            read: (p) => readFile(p).catch(() => null),
            write: writeFile,
            drain: drainKnownTypos,
          });
          for (const t of result.touched) {
            const idx = projectFiles.findIndex(p => p.path === t.path);
            if (idx >= 0) projectFiles[idx] = { ...projectFiles[idx], content: t.content };
          }
          if (result.touched.length > 0) {
            const summary = Object.entries(result.aggregate).map(([id, c]) => `${id}×${c}`).join(', ');
            runnerLog.info('RetryDrain', `Retry-path whole-project drain repaired ${result.touched.length} file(s): ${summary}`);
            log(`🧹 Retry-path drain: ${result.touched.length} file(s) — ${summary}`);
          }
        } catch (drainErr) {
          runnerLog.warn('RetryDrain', `Retry-path drain failed: ${drainErr}`);
        }

        errorLines.length = 0;
        updateState({ progress: 80 + fixAttempt * 3, message: `Retrying after fix (${fixAttempt}/${maxFixAttempts})...` });
      }
    }

    const totalMs = runnerLog.endTimer('auto-run-total');

    updateState({
      status: 'running',
      progress: 100,
      message: 'Application running!',
      previewUrl: url
    });

    runnerLog.success('AutoRunner', `Project "${projectName}" running at ${url}`, {
      totalTime: `${totalMs}ms`,
      totalFiles: files.length,
      projectType: projectType.type,
      url,
    }, totalMs);
    runnerLog.separator('AUTO-RUN COMPLETE');
    log(`🎉 Application running at ${url}`);

    lastSuccessfulPreviewUrl = url;
    sessionProjectHash = projectHash;
    return { success: true, previewUrl: url, error: null };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const totalMs = runnerLog.endTimer('auto-run-total');
    runnerLog.error('AutoRunner', `Pipeline failed for "${projectName}": ${errorMessage}`, {
      totalTime: `${totalMs}ms`,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3).join(' | ') : undefined,
    });
    runnerLog.separator('AUTO-RUN FAILED');
    updateState({ status: 'error', error: errorMessage, message: 'Error occurred' });
    callbacks.onError?.(errorMessage);
    log(`❌ Error: ${errorMessage}`);

    return { success: false, previewUrl: null, error: errorMessage };
  }
  };

  activeRunPromise = runPipeline().finally(() => {
    unsubPreWarm();
    activeRunId = null;
    activeRunPromise = null;
  });

  return activeRunPromise;
}

export function resetAutoRunGuard() {
  activeRunId = null;
  activeRunPromise = null;
  lastSuccessfulPreviewUrl = null;
  sessionProjectHash = null;
}

export async function quickRun(
  files: { path: string; content: string }[],
  onProgress?: (message: string, progress: number) => void
): Promise<string | null> {
  runnerLog.info('AutoRunner', `Quick run: ${files.length} files`);
  const result = await autoRunProject(files, 'quick-project', {
    onStatusChange: (state) => onProgress?.(state.message, state.progress),
    onLog: () => {}
  });

  return result.previewUrl;
}

// Check if files represent a runnable project
export function isRunnableProject(files: { path: string; content: string }[]): boolean {
  // Must have at least an entry point (supports both JS and TS)
  const hasEntryPoint = files.some(f =>
    f.path === 'index.html' ||
    f.path === 'src/main.jsx' ||
    f.path === 'src/main.tsx' ||
    f.path === 'src/index.jsx' ||
    f.path === 'src/index.tsx' ||
    f.path === 'server.js' ||
    f.path === 'server.ts' ||
    f.path === 'index.js' ||
    f.path === 'index.ts' ||
    f.path === 'app.js' ||
    f.path === 'app.ts'
  );

  return hasEntryPoint;
}

// Estimate install time based on dependencies
export function estimateInstallTime(files: { path: string; content: string }[]): number {
  const allCode = files.map(f => f.content).join('\n');
  const useTypeScript = files.some(f => f.path.endsWith('.ts') || f.path.endsWith('.tsx'));
  const { dependencies, devDependencies } = detectDependencies(allCode, useTypeScript);
  const depCount = Object.keys(dependencies).length + Object.keys(devDependencies).length;

  if (getPreWarmStatus() === 'ready') {
    const { deps: preWarmed, devDeps: preWarmedDev } = getPreWarmedPackages();
    const extraCount = Object.keys(dependencies).filter(d => !preWarmed[d]).length
      + Object.keys(devDependencies).filter(d => !preWarmedDev[d]).length;
    return 3 + (extraCount * 3);
  }

  return 5 + (depCount * 3);
}