import type { ProjectPlan } from './plan-generator.js';
import { detectStackFromPlan } from './stacks/stack-router.js';

export interface RunInstructions {
  prerequisites: string[];
  setupSteps: { label: string; command: string }[];
  devCommand: string;
  buildCommand: string;
  envVars: { name: string; description: string; example: string }[];
  testCommand: string;
  markdown: string;
  chatSnippet: string;
}

export function getRunInstructions(stack: string, plan?: { projectName?: string; name?: string; projectDescription?: string; description?: string; overview?: string; dataModel?: any[] }): RunInstructions {
  const projectName = plan?.projectName || plan?.name || 'my-app';
  const description = plan?.projectDescription || plan?.description || plan?.overview || '';
  const hasDb = (plan?.dataModel ?? []).length > 0;

  switch (stack) {
    case 'react-vite-express':
      return buildNodeInstructions(projectName, description, hasDb, 3000);
    case 'mern':
      return buildMERNInstructions(projectName, description);
    case 'django-react':
      return buildDjangoInstructions(projectName, description, hasDb);
    case 'spring-boot-react':
      return buildSpringBootInstructions(projectName, description, hasDb);
    case 'dotnet-react':
      return buildDotNetInstructions(projectName, description, hasDb);
    case 'go-gin-react':
      return buildGoGinInstructions(projectName, description, hasDb);
    default:
      return buildNodeInstructions(projectName, description, hasDb, 3000);
  }
}

export function getRunInstructionsFromPlan(plan: ProjectPlan): RunInstructions {
  const stack = detectStackFromPlan(plan);
  return getRunInstructions(stack, plan);
}

function buildMarkdown(
  projectName: string,
  description: string,
  prerequisites: string[],
  setupSteps: { label: string; command: string }[],
  devCommand: string,
  buildCommand: string,
  testCommand: string,
  envVars: { name: string; description: string; example: string }[],
  port: number,
  extraSections: string = '',
): string {
  const envBlock = envVars.length > 0
    ? `\n## Environment Variables\n\nSet the following environment variables (create a \`.env\` file or export them in your shell):\n\n| Variable | Description | Example |\n|----------|-------------|---------|\n${envVars.map(e => `| \`${e.name}\` | ${e.description} | \`${e.example}\` |`).join('\n')}\n`
    : '';

  return `# ${projectName}

${description}

## Prerequisites

${prerequisites.map(p => `- ${p}`).join('\n')}

## Getting Started

${setupSteps.map((s, i) => `### ${i + 1}. ${s.label}\n\n\`\`\`bash\n${s.command}\n\`\`\``).join('\n\n')}
${envBlock}
## Development

\`\`\`bash
${devCommand}
\`\`\`

Your app will be available at **http://localhost:${port}**

## Production Build

\`\`\`bash
${buildCommand}
\`\`\`

## Testing

\`\`\`bash
${testCommand}
\`\`\`
${extraSections}
## Deployment

If the project includes Docker configuration files:

- **Docker**: \`docker compose up --build -d\`
- **Manual**: See the \`Dockerfile\` for build steps

Otherwise, deploy using your platform's standard workflow (e.g., Vercel, Heroku, Railway, or a cloud VM).
`;
}

function buildChatSnippet(
  prerequisites: string[],
  setupSteps: { label: string; command: string }[],
  devCommand: string,
  port: number,
): string {
  const prereqs = prerequisites.join(', ');
  const commands = setupSteps.map(s => `# ${s.label}\n${s.command}`).join('\n\n');

  return `## How to Run

**Prerequisites:** ${prereqs}

\`\`\`bash
${commands}

# Start the development server
${devCommand}
\`\`\`

Your app will be running at **http://localhost:${port}**`;
}

function buildNodeInstructions(projectName: string, description: string, hasDb: boolean, port: number): RunInstructions {
  const prerequisites = ['Node.js 20+', 'npm or pnpm'];

  const setupSteps: { label: string; command: string }[] = [
    { label: 'Install dependencies', command: 'npm install' },
  ];

  const envVars: RunInstructions['envVars'] = [];

  if (hasDb) {
    setupSteps.push({ label: 'Configure environment', command: '# Create a .env file with your database URL and other settings' });
    envVars.push({ name: 'DATABASE_URL', description: 'Database connection string (if using a database)', example: 'postgresql://user:pass@localhost:5432/mydb' });
  }

  const devCommand = 'npm run dev';
  const buildCommand = 'npm run build';
  const testCommand = 'npm test';

  return {
    prerequisites,
    setupSteps,
    devCommand,
    buildCommand,
    testCommand,
    envVars,
    markdown: buildMarkdown(projectName, description, prerequisites, setupSteps, devCommand, buildCommand, testCommand, envVars, port),
    chatSnippet: buildChatSnippet(prerequisites, setupSteps, devCommand, port),
  };
}

function buildMERNInstructions(projectName: string, description: string): RunInstructions {
  const prerequisites = ['Node.js 20+', 'npm or pnpm', 'MongoDB 7+ (or MongoDB Atlas)'];

  const setupSteps: { label: string; command: string }[] = [
    { label: 'Install dependencies', command: 'npm install' },
    { label: 'Set up environment', command: 'cp .env.example .env\n# Edit .env with your MongoDB connection string' },
  ];

  const envVars: RunInstructions['envVars'] = [
    { name: 'MONGODB_URI', description: 'MongoDB connection string', example: 'mongodb://localhost:27017/mydb' },
    { name: 'JWT_SECRET', description: 'Secret key for JWT tokens', example: 'your-secret-key-here' },
  ];

  const devCommand = 'npm run dev';
  const buildCommand = 'npm run build';
  const testCommand = 'npm test';

  return {
    prerequisites,
    setupSteps,
    devCommand,
    buildCommand,
    testCommand,
    envVars,
    markdown: buildMarkdown(projectName, description, prerequisites, setupSteps, devCommand, buildCommand, testCommand, envVars, 3000),
    chatSnippet: buildChatSnippet(prerequisites, setupSteps, devCommand, 3000),
  };
}

function buildDjangoInstructions(projectName: string, description: string, hasDb: boolean): RunInstructions {
  const prerequisites = ['Python 3.12+', 'pip', 'Node.js 20+ (for React frontend)'];
  if (hasDb) prerequisites.push('PostgreSQL 15+');

  const setupSteps: { label: string; command: string }[] = [
    { label: 'Create a virtual environment', command: 'python -m venv venv\nsource venv/bin/activate  # On Windows: venv\\Scripts\\activate' },
    { label: 'Install Python dependencies', command: 'pip install -r requirements.txt' },
    { label: 'Set up environment', command: 'cp .env.example .env\n# Edit .env with your database URL and secret key' },
  ];

  const envVars: RunInstructions['envVars'] = [
    { name: 'SECRET_KEY', description: 'Django secret key', example: 'django-insecure-change-me-in-production' },
    { name: 'DEBUG', description: 'Debug mode (set False in production)', example: 'True' },
  ];

  setupSteps.push({ label: 'Run database migrations', command: 'python manage.py migrate' });

  if (hasDb) {
    setupSteps.push({ label: 'Create a superuser (optional)', command: 'python manage.py createsuperuser' });
    envVars.push({ name: 'DATABASE_URL', description: 'PostgreSQL connection string', example: 'postgresql://user:pass@localhost:5432/mydb' });
  }

  setupSteps.push({ label: 'Install frontend dependencies', command: 'npm install' });

  const devCommand = 'python manage.py runserver';
  const buildCommand = 'npm run build';
  const testCommand = 'python manage.py test';

  const extraSections = `
## Running Frontend

\`\`\`bash
npm run dev
\`\`\`

The React dev server runs on **http://localhost:5173** and proxies API requests to Django on port 8000.

## Admin Panel

Django admin is available at **http://localhost:8000/admin/** — log in with the superuser credentials you created.
`;

  return {
    prerequisites,
    setupSteps,
    devCommand,
    buildCommand,
    testCommand,
    envVars,
    markdown: buildMarkdown(projectName, description, prerequisites, setupSteps, devCommand, buildCommand, testCommand, envVars, 8000, extraSections),
    chatSnippet: buildChatSnippet(prerequisites, setupSteps, devCommand, 8000),
  };
}

function buildSpringBootInstructions(projectName: string, description: string, hasDb: boolean): RunInstructions {
  const prerequisites = ['Java 21+ (JDK)', 'Maven 3.9+ (or use the included Maven Wrapper)'];
  if (hasDb) prerequisites.push('PostgreSQL 15+');
  prerequisites.push('Node.js 20+ (for React frontend)');

  const setupSteps: { label: string; command: string }[] = [];

  const envVars: RunInstructions['envVars'] = [];

  if (hasDb) {
    setupSteps.push({ label: 'Configure database', command: '# Edit src/main/resources/application.properties with your database connection details' });
    envVars.push(
      { name: 'SPRING_DATASOURCE_URL', description: 'JDBC database URL', example: 'jdbc:postgresql://localhost:5432/mydb' },
      { name: 'SPRING_DATASOURCE_USERNAME', description: 'Database username', example: 'postgres' },
      { name: 'SPRING_DATASOURCE_PASSWORD', description: 'Database password', example: 'password' },
    );
  }

  setupSteps.push({ label: 'Install frontend dependencies', command: 'npm install' });
  setupSteps.push({ label: 'Build and run the backend', command: 'mvn spring-boot:run' });

  const devCommand = 'mvn spring-boot:run';
  const buildCommand = 'mvn clean package -DskipTests';
  const testCommand = 'mvn test';

  const extraSections = `
## Running Frontend

\`\`\`bash
npm run dev
\`\`\`

The React dev server runs on **http://localhost:5173** and proxies API requests to Spring Boot on port 8080.

## Useful Maven Commands

- **Run tests**: \`mvn test\`
- **Package as JAR**: \`mvn clean package\`
- **Run the JAR**: \`java -jar target/*.jar\`
`;

  return {
    prerequisites,
    setupSteps,
    devCommand,
    buildCommand,
    testCommand,
    envVars,
    markdown: buildMarkdown(projectName, description, prerequisites, setupSteps, devCommand, buildCommand, testCommand, envVars, 8080, extraSections),
    chatSnippet: buildChatSnippet(prerequisites, setupSteps, devCommand, 8080),
  };
}

function buildDotNetInstructions(projectName: string, description: string, hasDb: boolean): RunInstructions {
  const prerequisites = ['.NET 8 SDK'];
  if (hasDb) prerequisites.push('PostgreSQL 15+');
  prerequisites.push('Node.js 20+ (for React frontend)');

  const setupSteps: { label: string; command: string }[] = [
    { label: 'Restore .NET dependencies', command: 'dotnet restore' },
  ];

  const envVars: RunInstructions['envVars'] = [];

  if (hasDb) {
    setupSteps.push({ label: 'Configure database', command: '# Edit appsettings.json with your database connection string' });
    setupSteps.push({ label: 'Apply database migrations', command: 'dotnet ef database update' });
    envVars.push({ name: 'ConnectionStrings__DefaultConnection', description: 'Database connection string', example: 'Host=localhost;Database=mydb;Username=postgres;Password=password' });
  }

  setupSteps.push({ label: 'Install frontend dependencies', command: 'npm install' });

  const devCommand = 'dotnet run';
  const buildCommand = 'dotnet publish -c Release -o ./publish';
  const testCommand = 'dotnet test';

  const extraSections = `
## Running Frontend

\`\`\`bash
npm run dev
\`\`\`

The React dev server runs on **http://localhost:5173** and proxies API requests to the .NET backend on port 5000.

## Useful .NET Commands

- **Run in watch mode**: \`dotnet watch run\`
- **Add a migration**: \`dotnet ef migrations add MigrationName\`
- **Publish for production**: \`dotnet publish -c Release\`
`;

  return {
    prerequisites,
    setupSteps,
    devCommand,
    buildCommand,
    testCommand,
    envVars,
    markdown: buildMarkdown(projectName, description, prerequisites, setupSteps, devCommand, buildCommand, testCommand, envVars, 5000, extraSections),
    chatSnippet: buildChatSnippet(prerequisites, setupSteps, devCommand, 5000),
  };
}

function buildGoGinInstructions(projectName: string, description: string, hasDb: boolean): RunInstructions {
  const prerequisites = ['Go 1.22+'];
  if (hasDb) prerequisites.push('PostgreSQL 15+');
  prerequisites.push('Node.js 20+ (for React frontend)');

  const setupSteps: { label: string; command: string }[] = [
    { label: 'Download Go dependencies', command: 'go mod download' },
  ];

  const envVars: RunInstructions['envVars'] = [];

  if (hasDb) {
    setupSteps.push({ label: 'Configure database', command: '# Set DATABASE_URL environment variable or edit config' });
    envVars.push({ name: 'DATABASE_URL', description: 'PostgreSQL connection string', example: 'postgresql://user:pass@localhost:5432/mydb' });
  }

  envVars.push({ name: 'PORT', description: 'Server port', example: '8080' });

  setupSteps.push({ label: 'Install frontend dependencies', command: 'npm install' });

  const devCommand = 'go run main.go';
  const buildCommand = 'go build -o server main.go && npm run build';
  const testCommand = 'go test ./...';

  const extraSections = `
## Running Frontend

\`\`\`bash
npm run dev
\`\`\`

The React dev server runs on **http://localhost:5173** and proxies API requests to Go on port 8080.

## Useful Go Commands

- **Run tests**: \`go test ./...\`
- **Build binary**: \`go build -o server main.go\`
- **Run binary**: \`./server\`
- **Format code**: \`go fmt ./...\`
`;

  return {
    prerequisites,
    setupSteps,
    devCommand,
    buildCommand,
    testCommand,
    envVars,
    markdown: buildMarkdown(projectName, description, prerequisites, setupSteps, devCommand, buildCommand, testCommand, envVars, 8080, extraSections),
    chatSnippet: buildChatSnippet(prerequisites, setupSteps, devCommand, 8080),
  };
}
