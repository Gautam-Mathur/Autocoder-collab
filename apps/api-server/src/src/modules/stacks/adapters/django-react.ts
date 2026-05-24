/**
 * Stack Adapter: Django REST Framework + React Vite
 *
 * Generates:
 *   - Django project structure (settings, urls, wsgi, asgi)
 *   - Django REST Framework serializers + viewsets for each entity
 *   - requirements.txt
 *   - React Vite frontend (mostly keeps base files)
 */

import type { ProjectPlan } from '../../plan-generator.js';
import type { GeneratedFile } from '../../pipeline-orchestrator.js';
import { filterFrontendFiles } from './frontend-filter.js';

export interface AdapterResult {
  files: GeneratedFile[];
  warnings: string[];
}

function entityToDjangoModel(entity: any): string {
  const fields = (entity.fields ?? []).map((f: any) => {
    let fieldDef = '';
    if (f.type === 'number') fieldDef = `    ${f.name} = models.IntegerField(default=0)`;
    else if (f.type === 'boolean') fieldDef = `    ${f.name} = models.BooleanField(default=False)`;
    else if (f.type === 'date' || f.name.includes('_at')) fieldDef = `    ${f.name} = models.DateTimeField(auto_now_add=True)`;
    else if (f.name === 'email') fieldDef = `    ${f.name} = models.EmailField(unique=True)`;
    else fieldDef = `    ${f.name} = models.CharField(max_length=255${f.required ? '' : ', blank=True, null=True'})`;
    return fieldDef;
  }).join('\n');

  return `
class ${entity.name}(models.Model):
${fields || '    # TODO: add fields'}
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        verbose_name = '${entity.name}'

    def __str__(self):
        return f'${entity.name} #{self.pk}'
`;
}

export async function adaptDjangoReact(
  plan: ProjectPlan,
  baseFiles: GeneratedFile[]
): Promise<AdapterResult> {
  const warnings: string[] = [];
  const djangoFiles: GeneratedFile[] = [];
  const appName = (plan.projectName ?? 'app').toLowerCase().replace(/[^a-z0-9]/g, '_');

  // ── requirements.txt
  djangoFiles.push({
    path: 'requirements.txt',
    language: 'text',
    content: [
      'django>=5.0',
      'djangorestframework>=3.15',
      'django-cors-headers>=4.3',
      'psycopg2-binary>=2.9',
      'python-dotenv>=1.0',
      'gunicorn>=22.0',
      'django-filter>=24.0',
      'Pillow>=10.0',
    ].join('\n'),
  });

  // ── settings.py (always injected — frontend filter drops any LLM-produced
  // Python files, so this guarantees a runnable Django settings module)
  const settingsPath = `${appName}/settings.py`;
  djangoFiles.push({
    path: settingsPath,
    language: 'python',
    content: `import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-change-me')
DEBUG = os.environ.get('DEBUG', 'True') == 'True'
ALLOWED_HOSTS = os.environ.get('ALLOWED_HOSTS', '*').split(',')

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    'corsheaders',
    'api',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
]

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': os.environ.get('DB_NAME', '${appName}'),
        'USER': os.environ.get('DB_USER', 'postgres'),
        'PASSWORD': os.environ.get('DB_PASSWORD', ''),
        'HOST': os.environ.get('DB_HOST', 'localhost'),
        'PORT': os.environ.get('DB_PORT', '5432'),
    }
}

REST_FRAMEWORK = {
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': 20,
    'DEFAULT_FILTER_BACKENDS': ['django_filters.rest_framework.DjangoFilterBackend'],
}

CORS_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://localhost:3000']
CORS_ALLOW_CREDENTIALS = True

STATIC_URL = '/static/'
MEDIA_URL = '/media/'
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

ROOT_URLCONF = '${appName}.urls'
WSGI_APPLICATION = '${appName}.wsgi.application'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]
`,
  });
  warnings.push(`django-react adapter: injected baseline ${settingsPath}`);

  // ── models.py
  const modelDefs = (plan.dataModel ?? []).map(entityToDjangoModel).join('\n');
  djangoFiles.push({
    path: 'api/models.py',
    language: 'python',
    content: `from django.db import models\n${modelDefs}`,
  });

  // ── serializers.py / views.py / api/urls.py
  // When the data model is empty we still must emit syntactically valid
  // Python so Django can boot — empty `from .models import` would crash
  // at import time. Fall back to a minimal health endpoint module instead.
  const entityNames = (plan.dataModel ?? []).map((e: any) => e.name);

  if (entityNames.length === 0) {
    djangoFiles.push({
      path: 'api/serializers.py',
      language: 'python',
      content: `# No entities defined yet — placeholder module.\n`,
    });

    djangoFiles.push({
      path: 'api/views.py',
      language: 'python',
      content: `from rest_framework.decorators import api_view
from rest_framework.response import Response


@api_view(['GET'])
def health(_request):
    return Response({'status': 'ok'})
`,
    });

    djangoFiles.push({
      path: 'api/urls.py',
      language: 'python',
      content: `from django.urls import path
from .views import health

urlpatterns = [
    path('health/', health, name='health'),
]
`,
    });
    warnings.push('django-react adapter: no entities in data model — emitted health-only baseline serializers/views/urls');
  } else {
    const serializerDefs = entityNames.map((name: string) => `
class ${name}Serializer(serializers.ModelSerializer):
    class Meta:
        model = ${name}
        fields = '__all__'
        read_only_fields = ['id', 'created_at', 'updated_at']
`).join('\n');

    djangoFiles.push({
      path: 'api/serializers.py',
      language: 'python',
      content: `from rest_framework import serializers
from .models import ${entityNames.join(', ')}
${serializerDefs}`,
    });

    const viewsets = entityNames.map((name: string) => `
class ${name}ViewSet(viewsets.ModelViewSet):
    queryset = ${name}.objects.all()
    serializer_class = ${name}Serializer
    filterset_fields = ['id']
    ordering_fields = ['created_at']
    ordering = ['-created_at']
`).join('\n');

    djangoFiles.push({
      path: 'api/views.py',
      language: 'python',
      content: `from rest_framework import viewsets, filters
from django_filters.rest_framework import DjangoFilterBackend
from .models import ${entityNames.join(', ')}
from .serializers import ${entityNames.map((n: string) => `${n}Serializer`).join(', ')}
${viewsets}`,
    });

    djangoFiles.push({
      path: 'api/urls.py',
      language: 'python',
      content: `from rest_framework.routers import DefaultRouter
from .views import ${entityNames.map((n: string) => `${n}ViewSet`).join(', ')}

router = DefaultRouter()
${entityNames.map((n: string) => `router.register(r'${n.toLowerCase()}s', ${n}ViewSet)`).join('\n')}

urlpatterns = router.urls
`,
    });
  }

  // ── manage.py (always injected — guarantees Django CLI entry)
  djangoFiles.push({
    path: 'manage.py',
    language: 'python',
    content: `#!/usr/bin/env python
import os
import sys

def main():
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', '${appName}.settings')
    from django.core.management import execute_from_command_line
    execute_from_command_line(sys.argv)

if __name__ == '__main__':
    main()
`,
  });
  warnings.push('django-react adapter: injected baseline manage.py');

  // ── Project package __init__.py (always injected — Python package marker)
  djangoFiles.push({
    path: `${appName}/__init__.py`,
    language: 'python',
    content: '',
  });

  // ── Root urls.py — wires /api/ to api.urls and admin (always injected)
  djangoFiles.push({
    path: `${appName}/urls.py`,
    language: 'python',
    content: `from django.contrib import admin
from django.urls import path, include

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/', include('api.urls')),
]
`,
  });
  warnings.push(`django-react adapter: injected baseline ${appName}/urls.py`);

  // ── wsgi.py (always injected — required for production deployment)
  djangoFiles.push({
    path: `${appName}/wsgi.py`,
    language: 'python',
    content: `import os
from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', '${appName}.settings')
application = get_wsgi_application()
`,
  });

  // ── asgi.py (always injected)
  djangoFiles.push({
    path: `${appName}/asgi.py`,
    language: 'python',
    content: `import os
from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', '${appName}.settings')
application = get_asgi_application()
`,
  });

  // ── api app __init__.py and apps.py (always injected)
  djangoFiles.push({
    path: 'api/__init__.py',
    language: 'python',
    content: '',
  });
  djangoFiles.push({
    path: 'api/apps.py',
    language: 'python',
    content: `from django.apps import AppConfig


class ApiConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'api'
`,
  });

  // ── .env.example
  djangoFiles.push({
    path: '.env.example',
    language: 'text',
    content: `SECRET_KEY=change-me-to-a-long-random-string\nDEBUG=False\nDB_NAME=${appName}\nDB_USER=postgres\nDB_PASSWORD=changeme\nDB_HOST=localhost\nDB_PORT=5432\nALLOWED_HOSTS=localhost,127.0.0.1\n`,
  });

  const frontendFiles = filterFrontendFiles(baseFiles);

  if (!frontendFiles.some(f => f.path === 'setup.md') && !djangoFiles.some(f => f.path === 'setup.md')) {
    try {
      const { getRunInstructions } = await import('../../run-instructions.js');
      const ri = getRunInstructions('django-react', { projectName: plan.projectName, projectDescription: plan.overview, dataModel: plan.dataModel });
      djangoFiles.push({ path: 'setup.md', content: ri.markdown, language: 'markdown' });
    } catch {}
  }

  warnings.push(`Django adapter: kept ${frontendFiles.length} frontend files, generated ${djangoFiles.length} backend files`);

  return { files: [...frontendFiles, ...djangoFiles], warnings };
}
