import { describe, it, expect } from 'vitest';
import { buildProjectGraph, type GraphFile } from '../project-graph/graph-builder.js';
import { validateSemantics, formatSemanticErrors } from '../semantic-validator.js';

function build(files: GraphFile[]) {
  const graph = buildProjectGraph(files);
  return validateSemantics(graph, files);
}

describe('semantic-validator', () => {
  describe('orphan-state', () => {
    it('flags useState whose value/setter are never read', () => {
      const result = build([
        {
          path: 'src/components/Counter.tsx',
          content: [
            "import { useState } from 'react';",
            'export default function Counter() {',
            '  const [count, setCount] = useState(0);',
            '  return <div>hello</div>;',
            '}',
          ].join('\n'),
        },
      ]);
      const def = result.defects.find(d => d.category === 'orphan-state');
      expect(def).toBeDefined();
      expect(def?.severity).toBe('warn');
      expect(def?.humanReason).toMatch(/useState/);
      expect(def?.repairHint).toMatch(/Remove/);
    });

    it('does NOT flag useState that is actually used', () => {
      const result = build([
        {
          path: 'src/components/Counter.tsx',
          content: [
            "import { useState } from 'react';",
            'export default function Counter() {',
            '  const [count, setCount] = useState(0);',
            '  return <button onClick={() => setCount(count + 1)}>{count}</button>;',
            '}',
          ].join('\n'),
        },
      ]);
      expect(result.defects.find(d => d.category === 'orphan-state')).toBeUndefined();
    });
  });

  describe('dead-route', () => {
    it('flags backend routes with no FE caller', () => {
      const result = build([
        {
          path: 'server/routes/orphans.ts',
          content: [
            "import { Router } from 'express';",
            'const router = Router();',
            "router.get('/api/never-called', (req, res) => res.json({ ok: true }));",
            'export default router;',
          ].join('\n'),
        },
        {
          path: 'src/pages/Home.tsx',
          content: 'export default function Home() { return <div/>; }',
        },
      ]);
      const def = result.defects.find(d => d.category === 'dead-route');
      expect(def).toBeDefined();
      expect(def?.severity).toBe('warn');
      expect(def?.humanReason).toMatch(/no frontend caller/);
    });

    it('does NOT flag a route that has a matching FE call', () => {
      const result = build([
        {
          path: 'server/routes/users.ts',
          content: [
            "import { Router } from 'express';",
            'const router = Router();',
            "router.get('/api/users', (req, res) => res.json({ users: [] }));",
            'export default router;',
          ].join('\n'),
        },
        {
          path: 'src/pages/Users.tsx',
          content: [
            'export default function Users() {',
            "  fetch('/api/users');",
            '  return <div/>;',
            '}',
          ].join('\n'),
        },
      ]);
      expect(result.defects.find(d => d.category === 'dead-route')).toBeUndefined();
    });
  });

  describe('duplicate-ownership', () => {
    it('flags a singleton provider mounted in multiple files', () => {
      const result = build([
        {
          path: 'src/main.tsx',
          content: [
            "import { QueryClientProvider, QueryClient } from '@tanstack/react-query';",
            "import App from './App.tsx';",
            'const qc = new QueryClient();',
            'export function Root() {',
            '  return (<QueryClientProvider client={qc}><App/></QueryClientProvider>);',
            '}',
          ].join('\n'),
        },
        {
          path: 'src/App.tsx',
          content: [
            "import { QueryClientProvider, QueryClient } from '@tanstack/react-query';",
            'const qc = new QueryClient();',
            'export default function App() {',
            '  return (<QueryClientProvider client={qc}><div/></QueryClientProvider>);',
            '}',
          ].join('\n'),
        },
      ]);
      const def = result.defects.find(d => d.category === 'duplicate-ownership');
      expect(def).toBeDefined();
      expect(def?.severity).toBe('block');
      expect(def?.node).toBe('QueryClientProvider');
      expect(def?.relatedFiles?.length).toBeGreaterThan(0);
    });
  });

  describe('circular-ui', () => {
    it('flags circular component imports', () => {
      const result = build([
        {
          path: 'src/components/Alpha.tsx',
          content: [
            "import Beta from './Beta.tsx';",
            'export default function Alpha() { return <Beta/>; }',
          ].join('\n'),
        },
        {
          path: 'src/components/Beta.tsx',
          content: [
            "import Alpha from './Alpha.tsx';",
            'export default function Beta() { return <Alpha/>; }',
          ].join('\n'),
        },
      ]);
      const def = result.defects.find(d => d.category === 'circular-ui');
      expect(def).toBeDefined();
      expect(def?.severity).toBe('block');
      expect(def?.humanReason).toMatch(/[Cc]ircular/);
    });

    it('does NOT flag a non-cyclic import chain', () => {
      const result = build([
        {
          path: 'src/components/Alpha.tsx',
          content: [
            "import Beta from './Beta.tsx';",
            'export default function Alpha() { return <Beta/>; }',
          ].join('\n'),
        },
        {
          path: 'src/components/Beta.tsx',
          content: 'export default function Beta() { return <div/>; }',
        },
      ]);
      expect(result.defects.find(d => d.category === 'circular-ui')).toBeUndefined();
    });
  });

  describe('impossible-data-flow', () => {
    it('flags FE call with a method the route does not handle', () => {
      const result = build([
        {
          path: 'server/routes/items.ts',
          content: [
            "import { Router } from 'express';",
            'const router = Router();',
            "router.get('/api/items', (req, res) => res.json({ items: [] }));",
            'export default router;',
          ].join('\n'),
        },
        {
          path: 'src/pages/Items.tsx',
          content: [
            'export default function Items() {',
            "  fetch('/api/items', { method: 'POST' });",
            '  return <div/>;',
            '}',
          ].join('\n'),
        },
      ]);
      const def = result.defects.find(d => d.category === 'impossible-data-flow');
      expect(def).toBeDefined();
      expect(def?.severity).toBe('block');
    });

    it('flags FE call to a URL with no backend route', () => {
      const result = build([
        {
          path: 'server/routes/health.ts',
          content: [
            "import { Router } from 'express';",
            'const router = Router();',
            "router.get('/api/health', (req, res) => res.json({ ok: true }));",
            'export default router;',
          ].join('\n'),
        },
        {
          path: 'src/pages/Ghost.tsx',
          content: [
            'export default function Ghost() {',
            "  fetch('/api/does-not-exist', { method: 'GET' });",
            '  return <div/>;',
            '}',
          ].join('\n'),
        },
      ]);
      const def = result.defects.find(d => d.category === 'impossible-data-flow');
      expect(def).toBeDefined();
      expect(def?.humanReason).toMatch(/no backend route/);
    });

    it('flags request-shape mismatch when FE omits a body field the route reads', () => {
      const result = build([
        {
          path: 'server/routes/login.ts',
          content: [
            "import { Router } from 'express';",
            'const router = Router();',
            "router.post('/api/login', (req, res) => {",
            '  const { email, password } = req.body;',
            '  return res.json({ ok: true, email });',
            '});',
            'export default router;',
          ].join('\n'),
        },
        {
          path: 'src/pages/Login.tsx',
          content: [
            'export default function Login() {',
            '  async function submit() {',
            "    await fetch('/api/login', { method: 'POST', body: JSON.stringify({ email: 'a@b.c' }) });",
            '  }',
            '  return <button onClick={submit}/>;',
            '}',
          ].join('\n'),
        },
      ]);
      const def = result.defects.find(
        d => d.category === 'impossible-data-flow' && /omits field/.test(d.humanReason),
      );
      expect(def).toBeDefined();
      expect(def?.humanReason).toMatch(/password/);
    });
  });

  describe('formatSemanticErrors', () => {
    it('renders the [semantic] tagged shape that parseErrors accepts', () => {
      const result = build([
        {
          path: 'src/components/Counter.tsx',
          content: [
            "import { useState } from 'react';",
            'export default function Counter() {',
            '  const [count, setCount] = useState(0);',
            '  return <div>hi</div>;',
            '}',
          ].join('\n'),
        },
      ]);
      const lines = formatSemanticErrors(result);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toMatch(/^\[semantic\] /);
      expect(lines[0]).toMatch(/ \| hint: /);
    });
  });

  describe('safety', () => {
    it('never throws on empty graph', () => {
      const result = build([]);
      expect(result.defects).toEqual([]);
      expect(result.blocking).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  // Regression: Stage 15's auto-fix may mutate routes/imports/api calls
  // between graph build and semantic ship-gate. The orchestrator MUST
  // rebuild the graph immediately before the final gate so semantic
  // checks evaluate against the current topology, not a stale one.
  describe('graph freshness (Stage 15 ship gate regression)', () => {
    it('detects a defect that only exists after a file mutation when graph is rebuilt', () => {
      // Initial state: route + matching FE call → no defects.
      const initialFiles: GraphFile[] = [
        {
          path: 'server/routes/users.ts',
          content: [
            "import { Router } from 'express';",
            'const router = Router();',
            "router.get('/api/users', (req, res) => res.json({ users: [] }));",
            'export default router;',
          ].join('\n'),
        },
        {
          path: 'src/pages/Users.tsx',
          content: [
            'export default function Users() {',
            "  fetch('/api/users');",
            '  return <div/>;',
            '}',
          ].join('\n'),
        },
      ];
      const initialGraph = buildProjectGraph(initialFiles);
      const initialResult = validateSemantics(initialGraph, initialFiles);
      expect(initialResult.blocking).toHaveLength(0);

      // Stage 15 simulates a regeneration that drops the FE caller.
      const mutatedFiles: GraphFile[] = [
        initialFiles[0],
        {
          path: 'src/pages/Users.tsx',
          content: 'export default function Users() { return <div/>; }',
        },
      ];

      // BAD path: re-running the validator against the STALE graph misses
      // the new defect (the route still appears to have a caller).
      const stale = validateSemantics(initialGraph, mutatedFiles);
      expect(stale.defects.find(d => d.category === 'dead-route')).toBeUndefined();

      // GOOD path: rebuild the graph first — the dead-route is detected.
      const freshGraph = buildProjectGraph(mutatedFiles);
      const fresh = validateSemantics(freshGraph, mutatedFiles);
      expect(fresh.defects.find(d => d.category === 'dead-route')).toBeDefined();
    });
  });
});
