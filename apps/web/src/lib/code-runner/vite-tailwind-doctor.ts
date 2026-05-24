// Vite/Tailwind/PostCSS Doctor — single registry of every rule the auto-fixer
// applies to keep an LLM-generated Vite + Tailwind project bootable inside
// WebContainer. Every rule lives here. To add a new heuristic, append one
// entry to VITE_TAILWIND_DOCTOR — do NOT add ad-hoc regex elsewhere.

export type DoctorPhase = 'preflight' | 'startup' | 'runtime';
export type DoctorCategory = 'vite' | 'tailwind' | 'postcss' | 'webcontainer';

export interface DoctorChange {
  file: string;
  original: string;
  fixed: string;
}

export interface DoctorContext {
  files: { path: string; content: string }[];
  log?: (msg: string) => void;
}

export interface DoctorFix {
  id: string;
  category: DoctorCategory;
  phases: DoctorPhase[];
  description: string;
  detect: (ctx: DoctorContext, errorText?: string) => boolean;
  apply: (ctx: DoctorContext, errorText?: string) => DoctorChange[];
}

export interface DoctorReport {
  phase: DoctorPhase;
  fixesApplied: { id: string; description: string; files: string[] }[];
  codeChanges: DoctorChange[];
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const KNOWN_GOOD_VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': '/src',
      '@shared': '/shared',
    },
  },
  server: {
    host: '0.0.0.0',
  },
});
`;

const TW_V3_TAILWIND_CONFIG = `/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
`;

const TW_V3_POSTCSS_CONFIG = `module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TAILWIND_CONFIG_RE = /(^|\/)tailwind\.config\.(js|cjs|mjs|ts)$/;
const POSTCSS_CONFIG_RE = /(^|\/)postcss\.config\.(js|cjs|mjs|ts)$/;
const VITE_CONFIG_RE = /(^|\/)vite\.config\.(ts|js|mjs|cjs)$/;
// Vite + Vitest config files share the `defineConfig`-family call shape;
// the call-block repair rule applies to both. Keep this list in sync with
// DEFINE_CALLEE_RE below.
// Matches Vite, Vitest config and Vitest workspace files. The latter
// hosts `defineWorkspaceProject({...})` calls that share the same
// `()=>{` corruption shape as the others.
const VITE_OR_VITEST_CONFIG_RE = /(^|\/)(?:vite\.config|vitest\.config|vitest\.workspace)\.(ts|js|mjs|cjs|mts|cts)$/;
const DEFINE_CALLEE_RE = /\b(defineConfig|defineProject|defineWorkspaceProject)\(\s*\)\s*\{/;

function stripAnsi(s: string | undefined): string {
  if (!s) return '';
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

function findFile(ctx: DoctorContext, re: RegExp) {
  return ctx.files.find(f => re.test(f.path));
}

function projectUsesTailwind(ctx: DoctorContext): boolean {
  return ctx.files.some(f => {
    const c = f.content;
    return c.includes('@tailwind') ||
      /@import\s*(?:url\s*\(\s*)?["']tailwindcss/.test(c) ||
      /from\s+['"]tailwindcss/.test(c) ||
      /from\s+['"]@tailwindcss\//.test(c);
  });
}

function projectUsesReact(ctx: DoctorContext): boolean {
  const pkg = ctx.files.find(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
  if (pkg && /["']react["']\s*:/.test(pkg.content)) return true;
  return ctx.files.some(f => /\.[jt]sx$/.test(f.path));
}

function projectIsVite(ctx: DoctorContext): boolean {
  if (findFile(ctx, VITE_CONFIG_RE)) return true;
  const pkg = ctx.files.find(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
  return !!pkg && /["']vite["']\s*:/.test(pkg.content);
}

function pushChange(out: DoctorChange[], file: string, original: string, fixed: string) {
  if (original === fixed) return;
  out.push({ file, original, fixed });
}

// ---------------------------------------------------------------------------
// Rule registry
// ---------------------------------------------------------------------------

export const VITE_TAILWIND_DOCTOR: DoctorFix[] = [
  // ===== Vite config =====
  {
    id: 'vite-missing-config',
    category: 'vite',
    phases: ['preflight', 'startup'],
    description: 'Add a known-good vite.config.ts when one is missing in a Vite project.',
    detect: (ctx) => projectIsVite(ctx) && !findFile(ctx, VITE_CONFIG_RE),
    apply: (ctx) => {
      const out: DoctorChange[] = [];
      pushChange(out, 'vite.config.ts', '', KNOWN_GOOD_VITE_CONFIG);
      ctx.files.push({ path: 'vite.config.ts', content: KNOWN_GOOD_VITE_CONFIG });
      return out;
    },
  },
  {
    id: 'vite-fileurltopath',
    category: 'vite',
    phases: ['preflight', 'startup'],
    description: 'Strip fileURLToPath / import.meta.url from vite.config (incompatible with WebContainer).',
    detect: (ctx) => {
      const f = findFile(ctx, VITE_CONFIG_RE);
      return !!f && (f.content.includes('fileURLToPath') || f.content.includes('import.meta.url'));
    },
    apply: (ctx) => {
      const out: DoctorChange[] = [];
      const f = findFile(ctx, VITE_CONFIG_RE);
      if (!f) return out;
      let c = f.content
        .replace(/import\s*\{\s*fileURLToPath\s*\}\s*from\s*['"]url['"];?\n?/g, '')
        .replace(/const\s+__filename\s*=\s*fileURLToPath[^;\n]+;?\n?/g, '')
        .replace(/const\s+__dirname\s*=\s*path\.dirname\(__filename\);?\n?/g, '')
        .replace(/path\.resolve\(__dirname,\s*['"]\.\//g, "path.resolve('");
      pushChange(out, f.path, f.content, c);
      f.content = c;
      return out;
    },
  },
  {
    id: 'vite-defineconfig-call-block',
    category: 'vite',
    phases: ['preflight', 'startup', 'runtime'],
    description: 'Rewrite `defineConfig() {` (or defineProject/defineWorkspaceProject) to `defineConfig({` and close with `})` in vite/vitest config files.',
    detect: (ctx) => {
      // Match every vite.config.* AND vitest.config.* in the project, not
      // just the first one. Vitest config commonly lives next to vite
      // config and exhibits the same `defineConfig() {` LLM shape.
      return ctx.files.some(
        f => VITE_OR_VITEST_CONFIG_RE.test(f.path) && DEFINE_CALLEE_RE.test(f.content),
      );
    },
    apply: (ctx) => {
      const out: DoctorChange[] = [];
      for (const f of ctx.files) {
        if (!VITE_OR_VITEST_CONFIG_RE.test(f.path)) continue;
        if (!DEFINE_CALLEE_RE.test(f.content)) continue;
        // Rewrite `defineConfig() {`, `defineProject() {`, `defineWorkspaceProject() {`
        let c = f.content.replace(
          /\b(defineConfig|defineProject|defineWorkspaceProject)\(\s*\)\s*\{/g,
          '$1({',
        );
        // Close the file-final `}` with `});` — only when it lines up with
        // the export-default form we just rewrote.
        c = c.replace(/(\r?\n)(\s*)\}\s*;?\s*$/, '$1$2});');
        if (c !== f.content) {
          pushChange(out, f.path, f.content, c);
          f.content = c;
        }
      }
      return out;
    },
  },
  {
    id: 'jsx-mangled-arrow',
    category: 'vite',
    phases: ['preflight', 'startup', 'runtime'],
    description: 'Repair mangled JSX arrow `(e) = />` → `(e) =>` (Babel "Unterminated regular expression").',
    detect: (ctx) => ctx.files.some(
      f => /\.(tsx|jsx|ts|js|mjs|cjs)$/.test(f.path) && /\)\s*=\s*\/>/.test(f.content),
    ),
    apply: (ctx) => {
      const out: DoctorChange[] = [];
      for (const f of ctx.files) {
        if (!/\.(tsx|jsx|ts|js|mjs|cjs)$/.test(f.path)) continue;
        // Guarded: must follow `)` (signature of arrow params) so we don't
        // touch legitimate `prop = />` JSX (which would be invalid anyway).
        // Also covers bare-identifier arrows inside JSX braces: `={ident = />`.
        let c = f.content.replace(/(\))(\s*)=(\s*)\/>(\s*)/g, '$1$2=>$4');
        c = c.replace(/(=\{\s*[A-Za-z_$][\w$]*)(\s*)=(\s*)\/>(\s*)/g, '$1$2=>$4');
        if (c !== f.content) {
          pushChange(out, f.path, f.content, c);
          f.content = c;
        }
      }
      return out;
    },
  },
  {
    id: 'vite-esbuild-jsx-raw',
    category: 'vite',
    phases: ['preflight', 'startup'],
    description: 'Replace raw esbuild.jsx vite config with @vitejs/plugin-react.',
    detect: (ctx) => {
      const f = findFile(ctx, VITE_CONFIG_RE);
      return !!f && f.content.includes('esbuild') && f.content.includes('jsx') &&
        !f.content.includes('plugin-react');
    },
    apply: (ctx) => {
      const out: DoctorChange[] = [];
      const f = findFile(ctx, VITE_CONFIG_RE);
      if (!f) return out;
      pushChange(out, f.path, f.content, KNOWN_GOOD_VITE_CONFIG);
      f.content = KNOWN_GOOD_VITE_CONFIG;
      return out;
    },
  },
  {
    id: 'vite-no-defineconfig',
    category: 'vite',
    phases: ['preflight', 'startup'],
    description: 'Replace vite.config that has no defineConfig export with a known-good one.',
    detect: (ctx) => {
      const f = findFile(ctx, VITE_CONFIG_RE);
      return !!f && !f.content.includes('defineConfig');
    },
    apply: (ctx) => {
      const out: DoctorChange[] = [];
      const f = findFile(ctx, VITE_CONFIG_RE);
      if (!f) return out;
      pushChange(out, f.path, f.content, KNOWN_GOOD_VITE_CONFIG);
      f.content = KNOWN_GOOD_VITE_CONFIG;
      return out;
    },
  },

  // ===== Tailwind config =====
  {
    id: 'tailwind-v4-leak-config',
    category: 'tailwind',
    phases: ['preflight', 'startup'],
    description: 'Force-overwrite tailwind.config containing v4 markers (@plugin/@source/@tailwindcss).',
    detect: (ctx) => {
      const f = findFile(ctx, TAILWIND_CONFIG_RE);
      if (!f) return false;
      return /@plugin\b/.test(f.content) ||
        /@source\b/.test(f.content) ||
        /from\s+['"]@tailwindcss\//.test(f.content) ||
        /require\(\s*['"]@tailwindcss\//.test(f.content) ||
        !f.content.includes('content');
    },
    apply: (ctx) => {
      const out: DoctorChange[] = [];
      const f = findFile(ctx, TAILWIND_CONFIG_RE);
      if (!f) return out;
      pushChange(out, f.path, f.content, TW_V3_TAILWIND_CONFIG);
      f.content = TW_V3_TAILWIND_CONFIG;
      return out;
    },
  },
  {
    id: 'tailwind-missing-config',
    category: 'tailwind',
    phases: ['preflight', 'startup'],
    description: 'Add tailwind.config.ts when project uses Tailwind but no config exists.',
    detect: (ctx) => projectUsesTailwind(ctx) && !findFile(ctx, TAILWIND_CONFIG_RE),
    apply: (ctx) => {
      const out: DoctorChange[] = [];
      pushChange(out, 'tailwind.config.ts', '', TW_V3_TAILWIND_CONFIG);
      ctx.files.push({ path: 'tailwind.config.ts', content: TW_V3_TAILWIND_CONFIG });
      return out;
    },
  },
  {
    id: 'tailwind-css-v4-syntax',
    category: 'tailwind',
    phases: ['preflight', 'startup', 'runtime'],
    description: 'Convert @import "tailwindcss" / @plugin / @source / @theme in CSS to @tailwind directives.',
    detect: (ctx) => ctx.files.some(f =>
      f.path.endsWith('.css') && (
        /@import\s*(?:url\s*\(\s*)?["']tailwindcss/.test(f.content) ||
        /^[ \t]*@plugin\b/m.test(f.content) ||
        /^[ \t]*@source\b/m.test(f.content) ||
        /@theme\s*\{/.test(f.content)
      )
    ),
    apply: (ctx) => {
      const out: DoctorChange[] = [];
      for (const f of ctx.files) {
        if (!f.path.endsWith('.css')) continue;
        const original = f.content;
        const hasTwImport = /@import\s*(?:url\s*\(\s*)?["']tailwindcss/.test(original);
        const hasTwDirective = /@tailwind\s+(?:base|components|utilities)/.test(original);
        let c = original
          .replace(/@import\s*(?:url\s*\(\s*)?["']tailwindcss(?:\/[^"']*)?["']\s*\)?[^;\n]*;?\s*\n?/g, '')
          .replace(/^[ \t]*@source\b[^;\n]*;?\s*\n?/gm, '')
          .replace(/^[ \t]*@plugin\b[^;\n]*;?\s*\n?/gm, '')
          .replace(/@theme\s*\{[\s\S]*?\}\s*\n?/g, '');
        if (hasTwImport || hasTwDirective) {
          c = c.replace(/@tailwind\s+(?:base|components|utilities)\s*;?\s*\n?/g, '');
          c = '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n' + c.replace(/^\s+/, '');
        }
        if (c !== original) {
          pushChange(out, f.path, original, c);
          f.content = c;
        }
      }
      return out;
    },
  },

  // ===== PostCSS =====
  {
    id: 'postcss-v3-config',
    category: 'postcss',
    phases: ['preflight', 'startup', 'runtime'],
    description: 'Force postcss.config.cjs to v3 (tailwindcss + autoprefixer) when Tailwind is used.',
    detect: (ctx) => {
      if (!projectUsesTailwind(ctx)) return false;
      const f = findFile(ctx, POSTCSS_CONFIG_RE);
      if (!f) return true;
      // Already canonical → nothing to do (avoids infinite re-fire).
      const isCanonicalPath = f.path === 'postcss.config.cjs' || f.path.endsWith('/postcss.config.cjs');
      if (isCanonicalPath && f.content.trim() === TW_V3_POSTCSS_CONFIG.trim()) return false;
      return /@tailwindcss\/postcss/.test(f.content) || !isCanonicalPath ||
        f.content.trim() !== TW_V3_POSTCSS_CONFIG.trim();
    },
    apply: (ctx) => {
      const out: DoctorChange[] = [];
      const existing = findFile(ctx, POSTCSS_CONFIG_RE);
      if (existing) {
        const targetPath = existing.path.includes('/')
          ? existing.path.replace(/postcss\.config\.[^/]+$/, 'postcss.config.cjs')
          : 'postcss.config.cjs';
        // Update in place if already at canonical name; otherwise rewrite path.
        if (existing.path === targetPath) {
          pushChange(out, existing.path, existing.content, TW_V3_POSTCSS_CONFIG);
          existing.content = TW_V3_POSTCSS_CONFIG;
        } else {
          pushChange(out, existing.path, existing.content, '');
          // Non-destructive removal: filter via splice to preserve other refs.
          const idx = ctx.files.indexOf(existing);
          if (idx >= 0) ctx.files.splice(idx, 1);
          pushChange(out, targetPath, '', TW_V3_POSTCSS_CONFIG);
          ctx.files.push({ path: targetPath, content: TW_V3_POSTCSS_CONFIG });
        }
      } else {
        pushChange(out, 'postcss.config.cjs', '', TW_V3_POSTCSS_CONFIG);
        ctx.files.push({ path: 'postcss.config.cjs', content: TW_V3_POSTCSS_CONFIG });
      }
      return out;
    },
  },

  // ===== Package.json hygiene =====
  {
    id: 'tailwind-package-v4-leak',
    category: 'tailwind',
    phases: ['preflight'],
    description: 'Pin tailwindcss to v3 and remove @tailwindcss/* and lightningcss in package.json.',
    detect: (ctx) => {
      const pkg = ctx.files.find(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
      if (!pkg) return false;
      if (!projectUsesTailwind(ctx)) return false;
      try {
        const j = JSON.parse(pkg.content);
        const deps = { ...(j.dependencies || {}), ...(j.devDependencies || {}) };
        if (/^\^?4\./.test(deps.tailwindcss || '')) return true;
        if (deps['@tailwindcss/postcss'] || deps['@tailwindcss/vite'] || deps.lightningcss) return true;
        if (!deps.tailwindcss || !deps.autoprefixer || !deps.postcss) return true;
        if (!deps['@vitejs/plugin-react']) return true;
        return false;
      } catch {
        return false;
      }
    },
    apply: (ctx) => {
      const out: DoctorChange[] = [];
      const pkg = ctx.files.find(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
      if (!pkg) return out;
      try {
        const j = JSON.parse(pkg.content);
        j.devDependencies = {
          ...j.devDependencies,
          '@vitejs/plugin-react': '^4.2.0',
          tailwindcss: '^3.4.0',
          postcss: '^8.4.35',
          autoprefixer: '^10.4.17',
        };
        for (const bag of [j.dependencies, j.devDependencies]) {
          if (!bag) continue;
          delete bag['@tailwindcss/postcss'];
          delete bag['@tailwindcss/vite'];
          delete bag['@tailwindcss/forms'];
          delete bag.lightningcss;
        }
        const fixed = JSON.stringify(j, null, 2) + '\n';
        pushChange(out, pkg.path, pkg.content, fixed);
        pkg.content = fixed;
      } catch {
        /* ignore */
      }
      return out;
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function runViteTailwindDoctor(
  ctx: DoctorContext,
  phase: DoctorPhase,
  errorText?: string,
): DoctorReport {
  const cleanedError = stripAnsi(errorText);
  const report: DoctorReport = { phase, fixesApplied: [], codeChanges: [] };

  for (const rule of VITE_TAILWIND_DOCTOR) {
    if (!rule.phases.includes(phase)) continue;
    let fired = false;
    try {
      fired = rule.detect(ctx, cleanedError);
    } catch {
      fired = false;
    }
    if (!fired) continue;
    let changes: DoctorChange[] = [];
    try {
      changes = rule.apply(ctx, cleanedError);
    } catch {
      changes = [];
    }
    if (changes.length === 0) continue;
    report.codeChanges.push(...changes);
    report.fixesApplied.push({
      id: rule.id,
      description: rule.description,
      files: Array.from(new Set(changes.map(c => c.file))),
    });
    ctx.log?.(`🩺 ${rule.id}: ${rule.description} (${changes.length} file change${changes.length === 1 ? '' : 's'})`);
  }

  return report;
}

export function isViteOrTailwindError(errorText: string): boolean {
  const s = stripAnsi(errorText).toLowerCase();
  return /vite|tailwind|postcss|defineconfig|@tailwind|@plugin|@source|fileurltopath|esbuild-wasm/.test(s);
}

export { stripAnsi };
