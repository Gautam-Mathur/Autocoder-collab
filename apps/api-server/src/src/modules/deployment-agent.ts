/**
 * Deployment Agent — generates deployment artifacts from a generated project
 *
 * Supported targets:
 *   docker     — Dockerfile + docker-compose.yml + .env.example
 *   vercel     — vercel.json + build scripts
 *   railway    — railway.toml + Procfile
 *   kubernetes — k8s manifests (Deployment + Service + Ingress)
 *
 * Detects the stack automatically from generated files.
 */

import type { GeneratedFile } from './pipeline-orchestrator.js';

export type DeployTarget = 'docker' | 'vercel' | 'railway' | 'kubernetes';

export interface DeploymentBundle {
  target: DeployTarget;
  files: GeneratedFile[];
  instructions: string;
}

// ── Stack detection ────────────────────────────────────────────────────────

function detectRuntime(files: GeneratedFile[]): string {
  const paths = files.map(f => f.path);
  if (paths.some(p => p.endsWith('.py') || p === 'manage.py' || p === 'requirements.txt')) return 'python';
  if (paths.some(p => p.endsWith('.go') || p === 'go.mod')) return 'golang';
  if (paths.some(p => p.endsWith('.java') || p === 'pom.xml')) return 'java';
  if (paths.some(p => p.endsWith('.cs') || p.endsWith('.csproj'))) return 'dotnet';
  return 'node';
}

function detectMainEntrypoint(files: GeneratedFile[], runtime: string): string {
  switch (runtime) {
    case 'python': return files.some(f => f.path === 'manage.py') ? 'manage.py' : 'app.py';
    case 'golang': return 'main.go';
    case 'java': return './mvnw spring-boot:run';
    case 'dotnet': {
      const csproj = files.find(f => f.path.endsWith('.csproj'));
      return csproj ? `dotnet run --project ${csproj.path}` : 'dotnet run';
    }
    default: return 'server/index.ts';
  }
}

function getPackageJson(files: GeneratedFile[]): Record<string, any> | null {
  const pkgFile = files.find(f => f.path === 'package.json');
  if (!pkgFile) return null;
  try { return JSON.parse(pkgFile.content); } catch { return null; }
}

// ── Docker generation ──────────────────────────────────────────────────────

function generateDockerArtifacts(files: GeneratedFile[]): GeneratedFile[] {
  const runtime = detectRuntime(files);
  const pkg = getPackageJson(files);
  const projectName = pkg?.name ?? 'app';
  const generated: GeneratedFile[] = [];

  // ── Dockerfile
  let dockerfile = '';
  if (runtime === 'node') {
    dockerfile = `FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production

FROM base AS builder
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
`;
  } else if (runtime === 'python') {
    dockerfile = `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "4", "app.wsgi:application"]
`;
  } else if (runtime === 'golang') {
    dockerfile = `FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server ./main.go

FROM alpine:3.19
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/server ./
EXPOSE 8080
CMD ["./server"]
`;
  } else if (runtime === 'java') {
    dockerfile = `FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
`;
  } else if (runtime === 'dotnet') {
    dockerfile = `FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS base
WORKDIR /app
EXPOSE 80 443

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY *.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app/publish

FROM base AS final
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "*.dll"]
`;
  }

  generated.push({ path: 'Dockerfile', content: dockerfile, language: 'dockerfile' });

  // ── .dockerignore
  generated.push({
    path: '.dockerignore',
    content: `node_modules\n.env\n.env.*\ndist\nbuild\n*.log\n.git\n__pycache__\n*.pyc\ntarget\n`,
    language: 'text',
  });

  // ── docker-compose.yml
  const composeServices: Record<string, any> = {
    app: {
      build: '.',
      ports: [runtime === 'node' ? '3000:3000' : runtime === 'python' ? '8000:8000' : '8080:8080'],
      environment: ['NODE_ENV=production', 'DATABASE_URL=${DATABASE_URL}'],
      depends_on: ['db'],
      restart: 'unless-stopped',
    },
    db: {
      image: runtime === 'java' ? 'postgres:16-alpine' : 'postgres:16-alpine',
      environment: [
        'POSTGRES_DB=${DB_NAME:-appdb}',
        'POSTGRES_USER=${DB_USER:-appuser}',
        'POSTGRES_PASSWORD=${DB_PASSWORD:-changeme}',
      ],
      volumes: ['postgres_data:/var/lib/postgresql/data'],
      restart: 'unless-stopped',
    },
  };

  const compose = [
    `version: '3.9'`,
    `services:`,
    ...Object.entries(composeServices).flatMap(([name, svc]) => [
      `  ${name}:`,
      ...Object.entries(svc).flatMap(([k, v]) => {
        if (Array.isArray(v)) return [`    ${k}:`, ...v.map((item: string) => `      - ${item}`)];
        if (typeof v === 'object') return [`    ${k}:`, ...Object.entries(v as Record<string,string>).map(([ik, iv]) => `      ${ik}: ${iv}`)];
        return [`    ${k}: ${v}`];
      }),
    ]),
    `volumes:`,
    `  postgres_data:`,
  ].join('\n');

  generated.push({ path: 'docker-compose.yml', content: compose, language: 'yaml' });

  // ── .env.example
  const envVars = [
    '# Application',
    `NODE_ENV=production`,
    `PORT=3000`,
    '',
    '# Database',
    `DATABASE_URL=postgresql://appuser:changeme@db:5432/appdb`,
    `DB_NAME=appdb`,
    `DB_USER=appuser`,
    `DB_PASSWORD=changeme`,
    '',
    '# Auth',
    `JWT_SECRET=change-me-to-a-long-random-string`,
    `SESSION_SECRET=another-secret`,
    '',
    '# Optional',
    `# OPENAI_API_KEY=`,
    `# STRIPE_SECRET_KEY=`,
    `# SENDGRID_API_KEY=`,
  ].join('\n');

  generated.push({ path: '.env.example', content: envVars, language: 'text' });

  return generated;
}

// ── Vercel generation ──────────────────────────────────────────────────────

function generateVercelArtifacts(files: GeneratedFile[]): GeneratedFile[] {
  const hasServerDir = files.some(f => f.path.startsWith('server/'));
  const vercelJson = JSON.stringify(
    {
      buildCommand: 'npm run build',
      outputDirectory: 'dist',
      installCommand: 'npm ci',
      framework: null,
      ...(hasServerDir ? {
        routes: [
          { src: '/api/(.*)', dest: '/server/$1' },
          { src: '/(.*)', dest: '/dist/$1' },
        ],
      } : {}),
    },
    null,
    2
  );

  return [
    { path: 'vercel.json', content: vercelJson, language: 'json' },
    {
      path: '.env.example',
      content: `DATABASE_URL=\nJWT_SECRET=\nNODE_ENV=production\n`,
      language: 'text',
    },
  ];
}

// ── Railway generation ─────────────────────────────────────────────────────

function generateRailwayArtifacts(files: GeneratedFile[]): GeneratedFile[] {
  const runtime = detectRuntime(files);
  const startCmd = runtime === 'python' ? 'gunicorn app.wsgi:application'
    : runtime === 'golang' ? './server'
    : 'node dist/server/index.js';

  return [
    {
      path: 'railway.toml',
      content: `[build]\n  builder = "nixpacks"\n\n[deploy]\n  startCommand = "${startCmd}"\n  restartPolicyType = "ON_FAILURE"\n  restartPolicyMaxRetries = 3\n`,
      language: 'toml',
    },
    { path: 'Procfile', content: `web: ${startCmd}\n`, language: 'text' },
    { path: '.env.example', content: `DATABASE_URL=\nPORT=3000\nNODE_ENV=production\n`, language: 'text' },
  ];
}

// ── Kubernetes generation ──────────────────────────────────────────────────

function generateK8sArtifacts(files: GeneratedFile[]): GeneratedFile[] {
  const pkg = getPackageJson(files);
  const name = (pkg?.name ?? 'app').replace(/[^a-z0-9-]/g, '-');
  const port = 3000;

  const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app: ${name}
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: ${name}
        image: ${name}:latest
        ports:
        - containerPort: ${port}
        env:
        - name: NODE_ENV
          value: production
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: ${name}-secrets
              key: database-url
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /api/health
            port: ${port}
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /api/health
            port: ${port}
          initialDelaySeconds: 5
          periodSeconds: 5
`;

  const service = `apiVersion: v1
kind: Service
metadata:
  name: ${name}
spec:
  selector:
    app: ${name}
  ports:
  - protocol: TCP
    port: 80
    targetPort: ${port}
  type: ClusterIP
`;

  const ingress = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: ${name}.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: ${name}
            port:
              number: 80
`;

  return [
    { path: 'k8s/deployment.yaml', content: deployment, language: 'yaml' },
    { path: 'k8s/service.yaml', content: service, language: 'yaml' },
    { path: 'k8s/ingress.yaml', content: ingress, language: 'yaml' },
    { path: '.env.example', content: `DATABASE_URL=\nJWT_SECRET=\nNODE_ENV=production\n`, language: 'text' },
  ];
}

// ── Main export ────────────────────────────────────────────────────────────

export async function generateDeploymentBundle(
  files: GeneratedFile[],
  target: DeployTarget = 'docker'
): Promise<DeploymentBundle> {
  let deployFiles: GeneratedFile[];

  switch (target) {
    case 'docker':
      deployFiles = generateDockerArtifacts(files);
      break;
    case 'vercel':
      deployFiles = generateVercelArtifacts(files);
      break;
    case 'railway':
      deployFiles = generateRailwayArtifacts(files);
      break;
    case 'kubernetes':
      deployFiles = generateK8sArtifacts(files);
      break;
    default:
      deployFiles = generateDockerArtifacts(files);
  }

  const instructions = buildInstructions(target, detectRuntime(files));

  return { target, files: deployFiles, instructions };
}

function buildInstructions(target: DeployTarget, runtime: string): string {
  switch (target) {
    case 'docker':
      return [
        `# Docker Deployment`,
        `1. Copy .env.example to .env and fill in your values`,
        `2. Run: docker compose up --build -d`,
        `3. Run migrations: docker compose exec app npm run db:push`,
        `4. App available at http://localhost:3000`,
      ].join('\n');
    case 'vercel':
      return [
        `# Vercel Deployment`,
        `1. Install Vercel CLI: npm i -g vercel`,
        `2. Run: vercel --prod`,
        `3. Set environment variables in Vercel dashboard`,
      ].join('\n');
    case 'railway':
      return [
        `# Railway Deployment`,
        `1. Connect your GitHub repo in Railway dashboard`,
        `2. Set DATABASE_URL and other env vars`,
        `3. Railway auto-deploys on push to main`,
      ].join('\n');
    case 'kubernetes':
      return [
        `# Kubernetes Deployment`,
        `1. Build image: docker build -t your-registry/app:latest .`,
        `2. Push image: docker push your-registry/app:latest`,
        `3. Create secret: kubectl create secret generic app-secrets --from-literal=database-url=YOUR_URL`,
        `4. Apply manifests: kubectl apply -f k8s/`,
      ].join('\n');
  }
}
