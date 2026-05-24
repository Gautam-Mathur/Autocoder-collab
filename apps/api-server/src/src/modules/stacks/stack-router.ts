/**
 * Stack Router — dispatches generation to the correct stack adapter
 *
 * Supported stacks:
 *   react-vite-express   (default)
 *   mern                 (MongoDB + Express + React + Node)
 *   django-react         (Python Django REST + React Vite)
 *   spring-boot-react    (Java Spring Boot + React Vite)
 *   dotnet-react         (ASP.NET Core + React Vite)
 *   go-gin-react         (Go + Gin + React Vite)
 */

import type { ProjectPlan } from '../plan-generator.js';
import type { GeneratedFile } from '../pipeline-orchestrator.js';
import { adaptReactViteExpress } from './adapters/react-vite-express.js';
import { adaptMERN } from './adapters/mern.js';
import { adaptDjangoReact } from './adapters/django-react.js';
import { adaptSpringBootReact } from './adapters/spring-boot-react.js';
import { adaptDotNetReact } from './adapters/dotnet-react.js';
import { adaptGoGinReact } from './adapters/go-gin-react.js';

export type StackId =
  | 'react-vite-express'
  | 'mern'
  | 'django-react'
  | 'spring-boot-react'
  | 'dotnet-react'
  | 'go-gin-react';

export interface StackAdapterResult {
  stackId: StackId;
  files: GeneratedFile[];
  warnings: string[];
}

export function detectStackFromPlan(plan: ProjectPlan): StackId {
  const techRaw = plan.techStack;
  const tech = Array.isArray(techRaw)
    ? techRaw.map((t: any) => typeof t === 'string' ? t : [t.technology, t.category, t.name].filter(Boolean).join(' ')).join(' ').toLowerCase()
    : (typeof techRaw === 'string' ? techRaw : '').toLowerCase();
  const desc = ((plan as any).projectDescription ?? (plan as any).overview ?? '').toLowerCase();
  const combined = tech + ' ' + desc;

  if (combined.includes('django') || combined.includes('python')) return 'django-react';
  if (combined.includes('spring') || combined.includes('java')) return 'spring-boot-react';
  if (combined.includes('.net') || combined.includes('dotnet') || combined.includes('c#') || combined.includes('csharp')) return 'dotnet-react';
  if (combined.includes('go ') || combined.includes('golang') || combined.includes('gin')) return 'go-gin-react';
  if (combined.includes('mongo') || combined.includes('mern') || combined.includes('mongoose')) return 'mern';
  return 'react-vite-express';
}

export async function routeToStack(
  plan: ProjectPlan,
  baseFiles: GeneratedFile[],
  stackOverride?: StackId
): Promise<StackAdapterResult> {
  const stackId = stackOverride ?? detectStackFromPlan(plan);
  console.log(`[StackRouter] Routing to stack: ${stackId}`);

  switch (stackId) {
    case 'mern':
      return { stackId, ...(await adaptMERN(plan, baseFiles)) };
    case 'django-react':
      return { stackId, ...(await adaptDjangoReact(plan, baseFiles)) };
    case 'spring-boot-react':
      return { stackId, ...(await adaptSpringBootReact(plan, baseFiles)) };
    case 'dotnet-react':
      return { stackId, ...(await adaptDotNetReact(plan, baseFiles)) };
    case 'go-gin-react':
      return { stackId, ...(await adaptGoGinReact(plan, baseFiles)) };
    case 'react-vite-express':
    default:
      return { stackId: 'react-vite-express', ...(await adaptReactViteExpress(plan, baseFiles)) };
  }
}
