/**
 * Stack Adapter: React + Vite + Express (default stack)
 *
 * Injects canonical config files for a Vite/React frontend + Express backend monorepo.
 * Keeps all TypeScript/Drizzle conventions.
 */

import type { ProjectPlan } from '../../plan-generator.js';
import type { GeneratedFile } from '../../pipeline-orchestrator.js';

export interface AdapterResult {
  files: GeneratedFile[];
  warnings: string[];
}

export async function adaptReactViteExpress(
  plan: ProjectPlan,
  baseFiles: GeneratedFile[]
): Promise<AdapterResult> {
  const warnings: string[] = [];
  const extra: GeneratedFile[] = [];

  // Ensure tsconfig exists
  if (!baseFiles.some(f => f.path === 'tsconfig.json')) {
    extra.push({
      path: 'tsconfig.json',
      language: 'json',
      content: JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          lib: ['ES2020', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          jsx: 'react-jsx',
          skipLibCheck: true,
          resolveJsonModule: true,
          paths: { '@/*': ['./src/*'] },
        },
        include: ['src'],
        references: [{ path: './tsconfig.node.json' }],
      }, null, 2),
    });
  }

  // Ensure vite.config.ts exists
  if (!baseFiles.some(f => f.path === 'vite.config.ts')) {
    extra.push({
      path: 'vite.config.ts',
      language: 'typescript',
      content: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { transform as esbuildTransform } from 'esbuild';

// Test/story/fixture files are EXCLUDED from the dev-server file
// watcher so a broken test never triggers an HMR / transform error
// that blocks the app from booting. Patterns are mirrored in the
// AutoCoder verify-then-start gate (file-criticality.ts).
const NON_RUNTIME_PATTERNS = [
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.stories.*',
  '**/*.fixture.*',
  '**/examples/**',
  '**/docs/**',
];

// ────────────────────────────────────────────────────────────────────
// Transform-error firewall
// ────────────────────────────────────────────────────────────────────
// AutoCoder generated apps must keep Vite running even when individual
// generated files contain parser errors. Without this plugin, a single
// bad JSX file causes vite-plugin-react's Babel parser to throw, which
// surfaces as a full-screen red error overlay and breaks HMR for the
// whole app.
//
// This plugin runs with enforce:'pre' on .ts/.tsx/.js/.jsx files. For
// each module it attempts a fast esbuild parse. If the parse succeeds,
// it returns null and lets the normal vite-plugin-react pipeline run.
// If the parse FAILS, it returns a safe stub module so Vite (and the
// react plugin) never sees the broken source. Component-shaped files
// (.tsx/.jsx) get a no-op React component as the default export; other
// files get a Proxy-based default that silently absorbs any access.
//
// The result: the app boots in degraded mode with broken modules
// stubbed at the dev-server layer, regardless of whether the agent's
// upstream gates caught the issue.
const ERROR_FIREWALL_EXTS = /\\.(tsx|ts|jsx|js|mjs|cjs)$/;

function makeStubSource(filePath: string): string {
  const isComponent = /\\.(tsx|jsx)$/.test(filePath);
  const banner = \`/* [vite-firewall] stubbed: \${filePath} failed to parse */\`;
  if (isComponent) {
    return [
      banner,
      "import * as React from 'react';",
      "function StubComponent() {",
      "  return React.createElement('div', { 'data-stub': true, style: { display: 'none' } });",
      "}",
      "export default StubComponent;",
      // Common named-export fallbacks via Proxy on module namespace.
      "const __stubProxy = new Proxy({}, { get: () => StubComponent });",
      "export { __stubProxy as __stub };",
    ].join('\\n');
  }
  return [
    banner,
    "const __stub = new Proxy(function() {}, {",
    "  get: (_t, p) => (p === '__esModule' ? true : __stub),",
    "  apply: () => __stub,",
    "  construct: () => ({}),",
    "});",
    "export default __stub;",
  ].join('\\n');
}

function transformErrorFirewall() {
  return {
    name: 'autocoder:transform-error-firewall',
    enforce: 'pre' as const,
    async transform(code: string, id: string) {
      // Skip node_modules and virtual modules.
      if (!ERROR_FIREWALL_EXTS.test(id)) return null;
      if (id.includes('/node_modules/')) return null;
      if (id.startsWith('\\u0000') || id.includes('?')) return null;

      const ext = id.match(ERROR_FIREWALL_EXTS)?.[1] ?? 'tsx';
      const loader = ext === 'ts' ? 'ts'
        : ext === 'tsx' ? 'tsx'
        : ext === 'jsx' ? 'jsx'
        : 'js';

      try {
        await esbuildTransform(code, { loader, sourcefile: id, sourcemap: false });
        return null; // parse OK — let react plugin handle it
      } catch (err: any) {
        const msg = err?.errors?.[0]?.text ?? err?.message ?? String(err);
        // eslint-disable-next-line no-console
        console.warn(\`[vite-firewall] stubbed \${id}: \${msg}\`);
        const stub = makeStubSource(id);
        return { code: stub, map: null };
      }
    },

    // ──────────────────────────────────────────────────────────────────
    // L4 — Runtime error catcher (no white-screen)
    // ──────────────────────────────────────────────────────────────────
    // Injects a tiny script at the END of <head> that captures
    // window 'error' and 'unhandledrejection' events, suppresses the
    // Vite full-page error overlay for runtime errors, and renders a
    // dismissable corner toast instead. This catches everything the
    // L3 parse-firewall can't (render-time crashes, async errors, dep
    // resolution failures that surface at runtime, etc).
    transformIndexHtml(html: string) {
      const RUNTIME_ERROR_SHIM = [
        '<script>',
        '(function(){',
        '  var box=null;',
        '  function ensure(){',
        '    if(box) return box;',
        '    box=document.createElement("div");',
        '    box.id="__autocoder_err_toast";',
        '    box.style.cssText="position:fixed;bottom:12px;right:12px;max-width:420px;z-index:2147483647;font:13px/1.4 ui-monospace,monospace;background:#1f1300;color:#ffd6a5;border:1px solid #c2410c;border-radius:8px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.4);display:none";',
        '    document.body && document.body.appendChild(box);',
        '    return box;',
        '  }',
        '  function show(kind,msg,where){',
        '    try{',
        '      var b=ensure(); if(!b) return;',
        '      var safe=String(msg||"").replace(/[<>&]/g,function(c){return {"<":"&lt;",">":"&gt;","&":"&amp;"}[c]});',
        '      var loc=where?(" <span style=opacity:.7>"+String(where).replace(/[<>&]/g,function(c){return {"<":"&lt;",">":"&gt;","&":"&amp;"}[c]})+"</span>"):"";',
        '      b.innerHTML="<div style=display:flex;justify-content:space-between;gap:8px;align-items:flex-start><b style=color:#fdba74>"+kind+"</b><span style=cursor:pointer;opacity:.6 onclick=this.parentNode.parentNode.style.display=\\"none\\">×</span></div><div style=margin-top:4px>"+safe+loc+"</div>";',
        '      b.style.display="block";',
        '    }catch(_){}',
        '  }',
        '  window.addEventListener("error",function(e){',
        '    show("Runtime error",e.message||"(unknown)",e.filename?(e.filename+":"+e.lineno):"");',
        '  },true);',
        '  window.addEventListener("unhandledrejection",function(e){',
        '    var r=e&&e.reason; show("Unhandled promise",(r&&r.message)||String(r||"(unknown)"));',
        '  });',
        '  // Suppress Vite\\'s overlay for runtime errors (parse errors still show).',
        '  window.addEventListener("vite:error",function(e){',
        '    try{ var p=e&&e.payload; if(p && p.err && /at .* \\\\(/.test(String(p.err.stack||""))){ e.stopImmediatePropagation(); show("Vite runtime",p.err.message||"(unknown)"); } }catch(_){}',
        '  },true);',
        '})();',
        '</script>',
      ].join('');
      return html.replace('</head>', RUNTIME_ERROR_SHIM + '</head>');
    },

    // ──────────────────────────────────────────────────────────────────
    // L5 — safeLazy() helper for per-route isolation
    // ──────────────────────────────────────────────────────────────────
    // Generated routers can opt into:
    //   import { safeLazy } from 'virtual:autocoder/safe-lazy';
    //   const TeamPage = safeLazy(() => import('./pages/team-page'));
    // If the dynamic import fails (network, parse error post-firewall,
    // resolution miss), the route renders a tiny "Failed to load page"
    // card instead of breaking the whole router suspense boundary.
    resolveId(id: string) {
      if (id === 'virtual:autocoder/safe-lazy') return '\\0' + id;
      return null;
    },
    load(id: string) {
      if (id !== '\\0virtual:autocoder/safe-lazy') return null;
      return [
        "import * as React from 'react';",
        "function FallbackCard({ name, error }) {",
        "  return React.createElement('div', { 'data-stub-route': name||true, style: { padding: 24, margin: 16, border: '1px solid #c2410c', borderRadius: 8, background: '#1f1300', color: '#ffd6a5', font: '13px/1.4 ui-monospace,monospace' } },",
        "    React.createElement('b', { style: { color: '#fdba74' } }, 'Page failed to load'),",
        "    React.createElement('div', { style: { marginTop: 6, opacity: .8 } }, (error && error.message) || String(error||''))",
        "  );",
        "}",
        "export function safeLazy(loader, opts) {",
        "  var name = opts && opts.name;",
        "  return React.lazy(function() {",
        "    return loader().catch(function(err) {",
        "      try { console.warn('[safe-lazy] route stub:', name||'(anon)', err); } catch(_) {}",
        "      return { default: function() { return React.createElement(FallbackCard, { name: name, error: err }); } };",
        "    });",
        "  });",
        "}",
        "export default safeLazy;",
      ].join('\\n');
    },
  };
}

export default defineConfig({
  plugins: [transformErrorFirewall(), react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
    watch: { ignored: NON_RUNTIME_PATTERNS },
  },
});
`,
    });
  }

  // Ensure tailwind.config.js if tailwind is used
  const usesTailwind = baseFiles.some(f =>
    f.content.includes('tailwindcss') || f.content.includes('className="')
  );

  if (usesTailwind && !baseFiles.some(f => f.path === 'tailwind.config.js')) {
    extra.push({
      path: 'tailwind.config.js',
      language: 'javascript',
      content: `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#6366f1', hover: '#4f46e5' },
        surface: { DEFAULT: '#ffffff', dark: '#1e1e2e' },
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
};
`,
    });
  }

  // Ensure index.html exists (Vite entry HTML)
  if (!baseFiles.some(f => f.path === 'index.html')) {
    extra.push({
      path: 'index.html',
      language: 'html',
      content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${plan.projectName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    });
    warnings.push('react-vite-express adapter: injected fallback index.html (LLM omitted)');
  }

  // Ensure src/main.tsx exists (React mount)
  if (!baseFiles.some(f => f.path === 'src/main.tsx')) {
    extra.push({
      path: 'src/main.tsx',
      language: 'typescript',
      content: `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
    });
    warnings.push('react-vite-express adapter: injected fallback main.tsx (LLM omitted)');
  }

  // Ensure src/App.tsx exists (root component)
  if (!baseFiles.some(f => f.path === 'src/App.tsx')) {
    // Render projectName as a JS string literal so JSX-significant chars
    // ({, }, <, >, &, ', ") and backticks can't break the generated file.
    const nameLiteral = JSON.stringify(plan.projectName ?? 'App');
    extra.push({
      path: 'src/App.tsx',
      language: 'typescript',
      content: `const PROJECT_NAME = ${nameLiteral};

export default function App() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>{PROJECT_NAME}</h1>
      <p>Welcome! Your app is running.</p>
    </div>
  );
}
`,
    });
    warnings.push('react-vite-express adapter: injected fallback App.tsx (LLM omitted)');
  }

  if (extra.length === 0) warnings.push('react-vite-express adapter: all configs already present');

  const allFiles = [...baseFiles, ...extra];
  if (!allFiles.some(f => f.path === 'setup.md')) {
    try {
      const { getRunInstructions } = await import('../../run-instructions.js');
      const ri = getRunInstructions('react-vite-express', { projectName: plan.projectName, projectDescription: plan.overview, dataModel: plan.dataModel });
      allFiles.push({ path: 'setup.md', content: ri.markdown, language: 'markdown' });
    } catch {}
  }

  return { files: allFiles, warnings };
}
