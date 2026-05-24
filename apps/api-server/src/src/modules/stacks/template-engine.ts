/**
 * Template Engine — fills stack-specific file templates with plan data
 */

export interface TemplateContext {
  projectName: string;
  description?: string;
  entities: Array<{
    name: string;
    nameLower: string;
    namePlural: string;
    namePluralLower: string;
    fields: Array<{ name: string; type: string; required: boolean }>;
  }>;
  stack: string;
  port?: number;
}

export interface TemplatedFile {
  path: string;
  content: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function camelToKebab(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pluralize(s: string): string {
  if (s.endsWith('s')) return s + 'es';
  if (s.endsWith('y')) return s.slice(0, -1) + 'ies';
  return s + 's';
}

export function buildTemplateContext(
  projectName: string,
  description: string,
  entities: Array<{ name: string; fields?: Array<{ name: string; type: string; required?: boolean }> }>,
  stack: string,
  port = 3001,
): TemplateContext {
  return {
    projectName,
    description,
    stack,
    port,
    entities: entities.map(e => {
      const name = capitalize(e.name);
      const nameLower = e.name.toLowerCase();
      return {
        name,
        nameLower,
        namePlural: pluralize(name),
        namePluralLower: pluralize(nameLower),
        fields: (e.fields || [
          { name: 'id', type: 'number', required: true },
          { name: 'name', type: 'string', required: true },
          { name: 'createdAt', type: 'Date', required: true },
        ]).map(f => ({ name: f.name, type: f.type, required: f.required ?? true })),
      };
    }),
  };
}

// ── Token replacement ──────────────────────────────────────────────────────

function renderTemplate(template: string, ctx: TemplateContext, entity?: TemplateContext['entities'][0]): string {
  let out = template;
  out = out.replace(/\{\{PROJECT_NAME\}\}/g, ctx.projectName);
  out = out.replace(/\{\{PROJECT_NAME_KEBAB\}\}/g, camelToKebab(ctx.projectName));
  out = out.replace(/\{\{DESCRIPTION\}\}/g, ctx.description || ctx.projectName);
  out = out.replace(/\{\{STACK\}\}/g, ctx.stack);
  out = out.replace(/\{\{PORT\}\}/g, String(ctx.port || 3001));

  if (entity) {
    out = out.replace(/\{\{ENTITY_NAME\}\}/g, entity.name);
    out = out.replace(/\{\{ENTITY_NAME_LOWER\}\}/g, entity.nameLower);
    out = out.replace(/\{\{ENTITY_PLURAL\}\}/g, entity.namePlural);
    out = out.replace(/\{\{ENTITY_PLURAL_LOWER\}\}/g, entity.namePluralLower);
    const tsFields = entity.fields
      .map(f => `  ${f.name}${f.required ? '' : '?'}: ${f.type};`)
      .join('\n');
    out = out.replace(/\{\{ENTITY_FIELDS\}\}/g, tsFields);
    const insertFields = entity.fields
      .filter(f => f.name !== 'id' && f.name !== 'createdAt')
      .map(f => `  ${f.name}: ${f.type};`)
      .join('\n');
    out = out.replace(/\{\{ENTITY_INSERT_FIELDS\}\}/g, insertFields);
  }
  return out;
}

// ── Per-stack template sets ────────────────────────────────────────────────

const REACT_VITE_EXPRESS_TEMPLATES: Record<string, string> = {
  'package.json': `{
  "name": "{{PROJECT_NAME_KEBAB}}",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "concurrently \\"npm run dev:client\\" \\"npm run dev:server\\"",
    "dev:client": "vite",
    "dev:server": "tsx watch server/index.ts",
    "build": "vite build && tsc -p server/tsconfig.json",
    "start": "node dist/server/index.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/cors": "^2.8.17",
    "vite": "^5.0.0",
    "@vitejs/plugin-react": "^4.2.0",
    "tsx": "^4.7.0",
    "typescript": "^5.3.0",
    "concurrently": "^8.2.2"
  }
}`,
  'server/index.ts': `import express from 'express';
import cors from 'cors';
import { router } from './routes';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', router);

const PORT = process.env.PORT || {{PORT}};
app.listen(PORT, () => console.log(\`Server running on port \${PORT}\`));
`,
  'server/routes/{{ENTITY_NAME_LOWER}}.ts': `import { Router } from 'express';
import type { Request, Response } from 'express';

const router = Router();
const store: {{ENTITY_NAME}}[] = [];
let nextId = 1;

interface {{ENTITY_NAME}} {
{{ENTITY_FIELDS}}
}

router.get('/', (_req: Request, res: Response) => res.json(store));
router.get('/:id', (req: Request, res: Response) => {
  const item = store.find(i => i.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Not found' });
  return res.json(item);
});
router.post('/', (req: Request, res: Response) => {
  const item = { id: nextId++, ...req.body, createdAt: new Date() } as {{ENTITY_NAME}};
  store.push(item);
  res.status(201).json(item);
});
router.put('/:id', (req: Request, res: Response) => {
  const idx = store.findIndex(i => i.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  store[idx] = { ...store[idx], ...req.body };
  return res.json(store[idx]);
});
router.delete('/:id', (req: Request, res: Response) => {
  const idx = store.findIndex(i => i.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  store.splice(idx, 1);
  return res.status(204).end();
});

export default router;
`,
};

const DJANGO_TEMPLATES: Record<string, string> = {
  'requirements.txt': `django>=4.2,<5.0
djangorestframework>=3.14
django-cors-headers>=4.0
`,
  'manage.py': `#!/usr/bin/env python
import os
import sys

if __name__ == '__main__':
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', '{{PROJECT_NAME_KEBAB}}.settings')
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError('Could not import Django.') from exc
    execute_from_command_line(sys.argv)
`,
  'api/models.py': `from django.db import models

class {{ENTITY_NAME}}(models.Model):
    name = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.name
`,
  'api/serializers.py': `from rest_framework import serializers
from .models import {{ENTITY_NAME}}

class {{ENTITY_NAME}}Serializer(serializers.ModelSerializer):
    class Meta:
        model = {{ENTITY_NAME}}
        fields = '__all__'
`,
  'api/views.py': `from rest_framework import viewsets
from .models import {{ENTITY_NAME}}
from .serializers import {{ENTITY_NAME}}Serializer

class {{ENTITY_NAME}}ViewSet(viewsets.ModelViewSet):
    queryset = {{ENTITY_NAME}}.objects.all()
    serializer_class = {{ENTITY_NAME}}Serializer
`,
};

const GO_GIN_TEMPLATES: Record<string, string> = {
  'go.mod': `module {{PROJECT_NAME_KEBAB}}

go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
    github.com/gin-contrib/cors v1.5.0
)
`,
  'main.go': `package main

import (
    "net/http"
    "github.com/gin-gonic/gin"
    "github.com/gin-contrib/cors"
)

func main() {
    r := gin.Default()
    r.Use(cors.Default())
    api := r.Group("/api")
    Register{{ENTITY_PLURAL}}Routes(api)
    r.Run(":{{PORT}}")
}
`,
  'handlers/{{ENTITY_NAME_LOWER}}.go': `package handlers

import (
    "net/http"
    "strconv"
    "github.com/gin-gonic/gin"
)

type {{ENTITY_NAME}} struct {
    ID   int    \`json:"id"\`
    Name string \`json:"name"\`
}

var {{ENTITY_PLURAL_LOWER}} []{{ENTITY_NAME}}
var nextID = 1

func Register{{ENTITY_PLURAL}}Routes(rg *gin.RouterGroup) {
    g := rg.Group("/{{ENTITY_PLURAL_LOWER}}")
    g.GET("", List{{ENTITY_PLURAL}})
    g.POST("", Create{{ENTITY_NAME}})
    g.GET("/:id", Get{{ENTITY_NAME}})
    g.DELETE("/:id", Delete{{ENTITY_NAME}})
}

func List{{ENTITY_PLURAL}}(c *gin.Context) { c.JSON(http.StatusOK, {{ENTITY_PLURAL_LOWER}}) }
func Create{{ENTITY_NAME}}(c *gin.Context) {
    var item {{ENTITY_NAME}}
    if err := c.ShouldBindJSON(&item); err != nil { c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()}); return }
    item.ID = nextID; nextID++
    {{ENTITY_PLURAL_LOWER}} = append({{ENTITY_PLURAL_LOWER}}, item)
    c.JSON(http.StatusCreated, item)
}
func Get{{ENTITY_NAME}}(c *gin.Context) {
    id, _ := strconv.Atoi(c.Param("id"))
    for _, i := range {{ENTITY_PLURAL_LOWER}} { if i.ID == id { c.JSON(http.StatusOK, i); return } }
    c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
}
func Delete{{ENTITY_NAME}}(c *gin.Context) {
    id, _ := strconv.Atoi(c.Param("id"))
    for idx, i := range {{ENTITY_PLURAL_LOWER}} {
        if i.ID == id { {{ENTITY_PLURAL_LOWER}} = append({{ENTITY_PLURAL_LOWER}}[:idx], {{ENTITY_PLURAL_LOWER}}[idx+1:]...); c.Status(http.StatusNoContent); return }
    }
    c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
}
`,
};

// ── Stack template map ─────────────────────────────────────────────────────

const STACK_TEMPLATES: Record<string, Record<string, string>> = {
  'react-vite-express': REACT_VITE_EXPRESS_TEMPLATES,
  'django-react': DJANGO_TEMPLATES,
  'go-gin-react': GO_GIN_TEMPLATES,
};

// ── Public API ─────────────────────────────────────────────────────────────

export async function generateFromTemplates(ctx: TemplateContext): Promise<TemplatedFile[]> {
  const templates = STACK_TEMPLATES[ctx.stack] ?? STACK_TEMPLATES['react-vite-express'];
  const files: TemplatedFile[] = [];

  for (const [pathTemplate, contentTemplate] of Object.entries(templates)) {
    if (pathTemplate.includes('{{ENTITY')) {
      for (const entity of ctx.entities.length > 0 ? ctx.entities : [{ name: 'Item', nameLower: 'item', namePlural: 'Items', namePluralLower: 'items', fields: [] }]) {
        const path = renderTemplate(pathTemplate, ctx, entity);
        const content = renderTemplate(contentTemplate, ctx, entity);
        files.push({ path, content });
      }
    } else {
      const fallbackEntity = ctx.entities[0] ?? { name: 'Item', nameLower: 'item', namePlural: 'Items', namePluralLower: 'items', fields: [] };
      const path = renderTemplate(pathTemplate, ctx, fallbackEntity);
      const content = renderTemplate(contentTemplate, ctx, fallbackEntity);
      files.push({ path, content });
    }
  }

  try {
    const { getRunInstructions } = await import('../run-instructions.js');
    const instructions = getRunInstructions(ctx.stack, {
      projectName: ctx.projectName,
      projectDescription: ctx.description,
      dataModel: ctx.entities,
    });
    if (!files.some(f => f.path === 'setup.md')) {
      files.push({ path: 'setup.md', content: instructions.markdown });
    }
  } catch (e) {
    console.debug('[RunInstructions] Failed to generate setup.md in template engine:', e);
  }

  return files;
}
