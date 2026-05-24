/**
 * Stack Adapter: Go + Gin + React Vite
 *
 * Generates:
 *   go.mod, main.go, GORM models, Gin handlers, routes
 */

import type { ProjectPlan } from '../../plan-generator.js';
import type { GeneratedFile } from '../../pipeline-orchestrator.js';
import { filterFrontendFiles } from './frontend-filter.js';

export interface AdapterResult {
  files: GeneratedFile[];
  warnings: string[];
}

export async function adaptGoGinReact(
  plan: ProjectPlan,
  baseFiles: GeneratedFile[]
): Promise<AdapterResult> {
  const warnings: string[] = [];
  const goFiles: GeneratedFile[] = [];
  const moduleName = `github.com/app/${(plan.projectName ?? 'app').toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

  // ── go.mod
  goFiles.push({
    path: 'go.mod',
    language: 'go',
    content: `module ${moduleName}

go 1.22

require (
    github.com/gin-gonic/gin v1.9.1
    gorm.io/gorm v1.25.7
    gorm.io/driver/postgres v1.5.6
    github.com/joho/godotenv v1.5.1
    github.com/golang-jwt/jwt/v5 v5.2.0
)
`,
  });

  // ── GORM models
  for (const entity of plan.dataModel ?? []) {
    const fields = (entity as any).fields ?? [];
    const fieldDefs = fields.map((f: any) => {
      const goType = f.type === 'number' ? 'int'
        : f.type === 'boolean' ? 'bool'
        : f.type === 'date' ? 'time.Time'
        : 'string';
      const tag = f.name === 'email'
        ? `\`json:"${f.name}" gorm:"uniqueIndex;not null"\``
        : `\`json:"${f.name}"\``;
      return `    ${f.name.charAt(0).toUpperCase() + f.name.slice(1)} ${goType} ${tag}`;
    }).join('\n');

    goFiles.push({
      path: `internal/models/${entity.name.toLowerCase()}.go`,
      language: 'go',
      content: `package models

import (
    "time"
    "gorm.io/gorm"
)

type ${entity.name} struct {
    gorm.Model
${fieldDefs}
}
`,
    });

    // Handler
    goFiles.push({
      path: `internal/handlers/${entity.name.toLowerCase()}_handler.go`,
      language: 'go',
      content: `package handlers

import (
    "net/http"
    "strconv"
    "github.com/gin-gonic/gin"
    "gorm.io/gorm"
    "${moduleName}/internal/models"
)

type ${entity.name}Handler struct { DB *gorm.DB }

func (h *${entity.name}Handler) List(c *gin.Context) {
    var items []models.${entity.name}
    h.DB.Order("created_at desc").Find(&items)
    c.JSON(http.StatusOK, items)
}

func (h *${entity.name}Handler) Get(c *gin.Context) {
    id, _ := strconv.Atoi(c.Param("id"))
    var item models.${entity.name}
    if err := h.DB.First(&item, id).Error; err != nil { c.JSON(404, gin.H{"error": "not found"}); return }
    c.JSON(http.StatusOK, item)
}

func (h *${entity.name}Handler) Create(c *gin.Context) {
    var body models.${entity.name}
    if err := c.ShouldBindJSON(&body); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }
    h.DB.Create(&body)
    c.JSON(http.StatusCreated, body)
}

func (h *${entity.name}Handler) Update(c *gin.Context) {
    id, _ := strconv.Atoi(c.Param("id"))
    var body models.${entity.name}
    if err := c.ShouldBindJSON(&body); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }
    h.DB.Model(&models.${entity.name}{}).Where("id = ?", id).Updates(body)
    c.JSON(http.StatusOK, body)
}

func (h *${entity.name}Handler) Delete(c *gin.Context) {
    id, _ := strconv.Atoi(c.Param("id"))
    h.DB.Delete(&models.${entity.name}{}, id)
    c.JSON(http.StatusNoContent, nil)
}
`,
    });
  }

  // ── main.go (always injected — frontend filter drops any LLM-produced
  // Go files, so this guarantees a runnable entry point)
  // When no entities exist, omit handler/model imports + AutoMigrate args
  // entirely so `go build` succeeds against a health-only baseline.
  const entities = plan.dataModel ?? [];
  const hasEntities = entities.length > 0;

  const handlerImport = hasEntities ? `\n    "${moduleName}/internal/handlers"` : '';
  const modelImport = hasEntities ? `\n    "${moduleName}/internal/models"` : '';
  const autoMigrate = hasEntities
    ? `    db.AutoMigrate(${entities.map((e: any) => `&models.${e.name}{}`).join(', ')})`
    : `    _ = db // no entities to auto-migrate yet`;
  const handlerInits = entities.map((e: any) =>
    `    ${e.name.toLowerCase()}H := &handlers.${e.name}Handler{DB: db}`
  ).join('\n');
  const routeRegistrations = entities.map((e: any) => {
    const path = `/${e.name.toLowerCase()}s`;
    return `    api.GET("${path}", ${e.name.toLowerCase()}H.List)
    api.GET("${path}/:id", ${e.name.toLowerCase()}H.Get)
    api.POST("${path}", ${e.name.toLowerCase()}H.Create)
    api.PUT("${path}/:id", ${e.name.toLowerCase()}H.Update)
    api.DELETE("${path}/:id", ${e.name.toLowerCase()}H.Delete)`;
  }).join('\n');

  goFiles.push({
    path: 'main.go',
    language: 'go',
    content: `package main

import (
    "fmt"
    "log"
    "os"
    "github.com/gin-gonic/gin"
    "github.com/joho/godotenv"
    "gorm.io/driver/postgres"
    "gorm.io/gorm"${handlerImport}${modelImport}
)

func main() {
    godotenv.Load()

    dsn := os.Getenv("DATABASE_URL")
    if dsn == "" {
        dsn = fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable",
            getEnv("DB_HOST", "localhost"), getEnv("DB_USER", "postgres"),
            getEnv("DB_PASSWORD", ""), getEnv("DB_NAME", "appdb"), getEnv("DB_PORT", "5432"))
    }

    db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
    if err != nil { log.Fatal("Failed to connect to database:", err) }

${autoMigrate}

    r := gin.Default()
    r.Use(func(c *gin.Context) {
        c.Header("Access-Control-Allow-Origin", "*")
        c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        if c.Request.Method == "OPTIONS" { c.AbortWithStatus(204); return }
        c.Next()
    })

    api := r.Group("/api")
    api.GET("/health", func(c *gin.Context) { c.JSON(200, gin.H{"status": "ok"}) })

${handlerInits}
${routeRegistrations}

    port := getEnv("PORT", "8080")
    log.Printf("Server starting on :%s", port)
    r.Run(":" + port)
}

func getEnv(key, fallback string) string {
    if val, ok := os.LookupEnv(key); ok { return val }
    return fallback
}
`,
  });
  warnings.push(
    hasEntities
      ? 'go-gin-react adapter: injected baseline main.go entry'
      : 'go-gin-react adapter: no entities in data model — emitted health-only baseline main.go'
  );

  const frontendFiles = filterFrontendFiles(baseFiles);

  if (!frontendFiles.some(f => f.path === 'setup.md') && !goFiles.some(f => f.path === 'setup.md')) {
    try {
      const { getRunInstructions } = await import('../../run-instructions.js');
      const ri = getRunInstructions('go-gin-react', { projectName: plan.projectName, projectDescription: plan.overview, dataModel: plan.dataModel });
      goFiles.push({ path: 'setup.md', content: ri.markdown, language: 'markdown' });
    } catch {}
  }

  warnings.push(`Go+Gin adapter: ${goFiles.length} Go files, ${frontendFiles.length} frontend files`);
  return { files: [...frontendFiles, ...goFiles], warnings };
}
