/**
 * Stack Adapter: MERN (MongoDB + Express + React + Node)
 *
 * Converts TypeScript/Drizzle-centric files to Mongoose schemas,
 * adds MongoDB connection boilerplate, and adjusts package.json.
 */

import type { ProjectPlan } from '../../plan-generator.js';
import type { GeneratedFile } from '../../pipeline-orchestrator.js';

export interface AdapterResult {
  files: GeneratedFile[];
  warnings: string[];
}

function entityToMongooseSchema(entityName: string, fields: any[]): string {
  const fieldDefs = (fields ?? []).map((f: any) => {
    const type = f.type === 'number' ? 'Number'
      : f.type === 'boolean' ? 'Boolean'
      : f.type === 'date' ? 'Date'
      : 'String';
    const required = f.required ? ', required: true' : '';
    return `  ${f.name}: { type: ${type}${required} }`;
  }).join(',\n');

  return `import mongoose, { Schema, Document } from 'mongoose';

export interface I${entityName} extends Document {
${(fields ?? []).map((f: any) => `  ${f.name}: ${f.type === 'number' ? 'number' : f.type === 'boolean' ? 'boolean' : 'string'};`).join('\n')}
  createdAt: Date;
  updatedAt: Date;
}

const ${entityName}Schema = new Schema<I${entityName}>({
${fieldDefs}
}, {
  timestamps: true,
  versionKey: false,
});

// Indexes
${entityName}Schema.index({ createdAt: -1 });

export const ${entityName} = mongoose.model<I${entityName}>('${entityName}', ${entityName}Schema);
`;
}

export async function adaptMERN(
  plan: ProjectPlan,
  baseFiles: GeneratedFile[]
): Promise<AdapterResult> {
  const warnings: string[] = [];
  const mernFiles: GeneratedFile[] = [];

  // ── MongoDB connection
  mernFiles.push({
    path: 'server/db/connection.ts',
    language: 'typescript',
    content: `import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/${plan.projectName ?? 'app'}';

export async function connectDB(): Promise<void> {
  if (mongoose.connection.readyState >= 1) return;
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
  console.log('[DB] Connected to MongoDB');
}

mongoose.connection.on('error', (err) => {
  console.error('[DB] MongoDB error:', err);
});
`,
  });

  // ── Mongoose models for each entity
  for (const entity of plan.dataModel ?? []) {
    mernFiles.push({
      path: `server/models/${entity.name}.model.ts`,
      language: 'typescript',
      content: entityToMongooseSchema(entity.name, (entity as any).fields ?? []),
    });
  }

  const filteredBase = baseFiles.filter(f =>
    !f.path.includes('drizzle') &&
    !(f.path === 'shared/schema.ts') &&
    !f.path.includes('migration')
  );

  if (filteredBase.length < baseFiles.length) {
    warnings.push(`MERN adapter: removed ${baseFiles.length - filteredBase.length} Drizzle schema files`);
  }

  // ── Server entry (Express + Mongoose) — fallback only when LLM omits
  const entityNames = (plan.dataModel ?? []).map((e: any) => e.name);
  // Restrict server-entry detection to explicit `server/*` paths so root
  // `index.ts`/`index.js` (commonly the React/Vite client entry in some
  // layouts) does not produce a false positive.
  const serverEntryCandidates = ['server/index.ts', 'server/index.js', 'server/server.ts', 'server/server.js', 'server/main.ts', 'server/main.js', 'server/app.ts', 'server/app.js'];
  const hasServerEntry = baseFiles.some(f =>
    serverEntryCandidates.includes(f.path) ||
    (/^server\/.+\.(t|j)s$/.test(f.path) && /express\(\)/.test(f.content) && /\.listen\s*\(/.test(f.content))
  );
  if (!hasServerEntry) {
    mernFiles.push({
      path: 'server/index.ts',
      language: 'typescript',
      content: `import express from 'express';
import cors from 'cors';
import { connectDB } from './db/connection.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:3000'], credentials: true }));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

async function start() {
  await connectDB();
${entityNames.length === 0 ? '  // TODO: register entity routes here' : entityNames.map((n: string) => `  // TODO: register routes for ${n}`).join('\n')}
  app.listen(PORT, () => {
    console.log(\`[server] listening on http://localhost:\${PORT}\`);
  });
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
`,
    });
    warnings.push('mern adapter: injected fallback server/index.ts (LLM omitted)');
  }

  // ── React mount entry detection — must happen BEFORE the HTML fallback
  // so the injected `index.html` can point its <script src> at the actual
  // mount file (existing or fallback).
  // We deliberately pair a fallback `src/main.tsx` with a fallback
  // `src/App.tsx` at exactly that path: the fallback imports `./App`, so on
  // case-sensitive filesystems an existing `src/app.tsx` would not resolve.
  // Only the canonical capital-A `App` paths are accepted as "already
  // present" candidates.
  const clientMountCandidates = ['src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx'];
  const appCandidates = ['src/App.tsx', 'src/App.jsx'];
  const existingMount = baseFiles.find(f => clientMountCandidates.includes(f.path));
  const mountInjected = !existingMount;
  const mountScriptPath = '/' + (existingMount?.path ?? 'src/main.tsx');
  const appPresent = baseFiles.some(f => appCandidates.includes(f.path));

  // ── Client HTML entry — fallback only when LLM omits. The script src is
  // wired to the detected/injected mount so it is always resolvable.
  if (!baseFiles.some(f => f.path === 'index.html')) {
    mernFiles.push({
      path: 'index.html',
      language: 'html',
      content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${plan.projectName ?? 'App'}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${mountScriptPath}"></script>
  </body>
</html>
`,
    });
    warnings.push(`mern adapter: injected fallback index.html (LLM omitted) wired to ${mountScriptPath}`);
  }

  if (mountInjected) {
    mernFiles.push({
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
    warnings.push('mern adapter: injected fallback src/main.tsx (LLM omitted)');
  }

  // Always pair the fallback main with a matching App at src/App.tsx so the
  // `./App` import resolves regardless of LLM output. Inject when no
  // canonical capital-A App exists, OR when we just injected the fallback
  // main entry (defensive coupling).
  if (!appPresent || mountInjected) {
    if (!baseFiles.some(f => f.path === 'src/App.tsx') && !mernFiles.some(f => f.path === 'src/App.tsx')) {
      const nameLiteral = JSON.stringify(plan.projectName ?? 'App');
      mernFiles.push({
        path: 'src/App.tsx',
        language: 'typescript',
        content: `const PROJECT_NAME = ${nameLiteral};

export default function App() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>{PROJECT_NAME}</h1>
      <p>Welcome! Your MERN app is running.</p>
    </div>
  );
}
`,
      });
      warnings.push('mern adapter: injected fallback src/App.tsx (LLM omitted or paired with fallback main)');
    }
  }

  // ── .env.example for MongoDB
  const hasEnvExample = baseFiles.some(f => f.path === '.env.example');
  if (!hasEnvExample) {
    mernFiles.push({
      path: '.env.example',
      language: 'text',
      content: `MONGODB_URI=mongodb://localhost:27017/${plan.projectName ?? 'app'}\nPORT=3001\nJWT_SECRET=changeme\nNODE_ENV=development\n`,
    });
  }

  const allFiles = [...filteredBase, ...mernFiles];
  if (!allFiles.some(f => f.path === 'setup.md')) {
    try {
      const { getRunInstructions } = await import('../../run-instructions.js');
      const ri = getRunInstructions('mern', { projectName: plan.projectName, projectDescription: plan.overview, dataModel: plan.dataModel });
      allFiles.push({ path: 'setup.md', content: ri.markdown, language: 'markdown' });
    } catch {}
  }

  return { files: allFiles, warnings };
}
