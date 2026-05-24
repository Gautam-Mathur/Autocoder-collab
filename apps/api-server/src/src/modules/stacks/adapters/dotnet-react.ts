/**
 * Stack Adapter: ASP.NET Core + React Vite
 *
 * Generates minimal ASP.NET Core Web API scaffold:
 *   *.csproj, Program.cs, appsettings.json,
 *   Entity models, DbContext, Controllers
 */

import type { ProjectPlan } from '../../plan-generator.js';
import type { GeneratedFile } from '../../pipeline-orchestrator.js';
import { filterFrontendFiles } from './frontend-filter.js';

export interface AdapterResult {
  files: GeneratedFile[];
  warnings: string[];
}

export async function adaptDotNetReact(
  plan: ProjectPlan,
  baseFiles: GeneratedFile[]
): Promise<AdapterResult> {
  const warnings: string[] = [];
  const dotnetFiles: GeneratedFile[] = [];
  const projectName = (plan.projectName ?? 'App')
    .split(/[-_ ]+/)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');

  // ── .csproj
  dotnetFiles.push({
    path: `${projectName}.csproj`,
    language: 'xml',
    content: `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="8.0.0" />
    <PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8.0.0" />
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="8.0.0" />
    <PackageReference Include="Swashbuckle.AspNetCore" Version="6.5.0" />
  </ItemGroup>
</Project>
`,
  });

  // ── Program.cs (always injected — frontend filter drops any LLM-produced
  // C# files, so this guarantees a runnable entry point)
  dotnetFiles.push({
    path: 'Program.cs',
    language: 'csharp',
    content: `using Microsoft.EntityFrameworkCore;
using ${projectName}.Data;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("DefaultConnection")));

builder.Services.AddCors(options => {
    options.AddPolicy("DevPolicy", policy => {
        policy.WithOrigins("http://localhost:5173", "http://localhost:3000")
              .AllowAnyHeader().AllowAnyMethod().AllowCredentials();
    });
});

var app = builder.Build();

if (app.Environment.IsDevelopment()) {
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseCors("DevPolicy");
app.UseHttpsRedirection();
app.UseAuthorization();
app.MapControllers();

app.Run();
`,
  });
  warnings.push('dotnet-react adapter: injected baseline Program.cs entry');

  // ── appsettings.json
  dotnetFiles.push({
    path: 'appsettings.json',
    language: 'json',
    content: JSON.stringify({
      ConnectionStrings: {
        DefaultConnection: `Host=localhost;Database=${projectName.toLowerCase()};Username=postgres;Password=`,
      },
      Logging: {
        LogLevel: { Default: 'Information', 'Microsoft.AspNetCore': 'Warning' },
      },
      AllowedHosts: '*',
    }, null, 2),
  });

  // ── AppDbContext
  // When no entities exist we must omit `using ${projectName}.Models;`
  // because no Models/ files will be generated and the namespace would not
  // resolve. We also emit a minimal HealthController so the baseline app
  // exposes at least one route without requiring any models.
  const entityNames = (plan.dataModel ?? []).map((e: any) => e.name);
  const hasEntities = entityNames.length > 0;
  dotnetFiles.push({
    path: `Data/AppDbContext.cs`,
    language: 'csharp',
    content: `using Microsoft.EntityFrameworkCore;${hasEntities ? `\nusing ${projectName}.Models;` : ''}

namespace ${projectName}.Data;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) {}
${hasEntities ? '\n' + entityNames.map((n: string) => `    public DbSet<${n}> ${n}s { get; set; } = default!;`).join('\n') + '\n' : ''}}
`,
  });

  if (!hasEntities) {
    dotnetFiles.push({
      path: 'Controllers/HealthController.cs',
      language: 'csharp',
      content: `using Microsoft.AspNetCore.Mvc;

namespace ${projectName}.Controllers;

[ApiController]
[Route("api/[controller]")]
public class HealthController : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(new { status = "ok" });
}
`,
    });
    warnings.push('dotnet-react adapter: no entities in data model — emitted health-only baseline controller');
  }

  // ── Models
  for (const entity of plan.dataModel ?? []) {
    const fields = (entity as any).fields ?? [];
    const props = fields.map((f: any) => {
      const csType = f.type === 'number' ? 'int'
        : f.type === 'boolean' ? 'bool'
        : f.type === 'date' ? 'DateTime'
        : 'string';
      const nullability = f.required || csType === 'int' || csType === 'bool' ? '' : '?';
      return `    public ${csType}${nullability} ${f.name.charAt(0).toUpperCase() + f.name.slice(1)} { get; set; }`;
    }).join('\n');

    dotnetFiles.push({
      path: `Models/${entity.name}.cs`,
      language: 'csharp',
      content: `namespace ${projectName}.Models;

public class ${entity.name}
{
    public int Id { get; set; }
${props}
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
`,
    });

    // Controller
    dotnetFiles.push({
      path: `Controllers/${entity.name}Controller.cs`,
      language: 'csharp',
      content: `using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using ${projectName}.Data;
using ${projectName}.Models;

namespace ${projectName}.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ${entity.name}Controller : ControllerBase
{
    private readonly AppDbContext _db;
    public ${entity.name}Controller(AppDbContext db) => _db = db;

    [HttpGet]
    public async Task<IActionResult> List() => Ok(await _db.${entity.name}s.OrderByDescending(x => x.CreatedAt).ToListAsync());

    [HttpGet("{id}")]
    public async Task<IActionResult> Get(int id) {
        var item = await _db.${entity.name}s.FindAsync(id);
        return item is null ? NotFound() : Ok(item);
    }

    [HttpPost]
    public async Task<IActionResult> Create(${entity.name} body) {
        _db.${entity.name}s.Add(body); await _db.SaveChangesAsync();
        return CreatedAtAction(nameof(Get), new { id = body.Id }, body);
    }

    [HttpPut("{id}")]
    public async Task<IActionResult> Update(int id, ${entity.name} body) {
        body.Id = id; body.UpdatedAt = DateTime.UtcNow;
        _db.Entry(body).State = EntityState.Modified;
        await _db.SaveChangesAsync(); return Ok(body);
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(int id) {
        var item = await _db.${entity.name}s.FindAsync(id);
        if (item is null) return NotFound();
        _db.${entity.name}s.Remove(item); await _db.SaveChangesAsync(); return NoContent();
    }
}
`,
    });
  }

  const frontendFiles = filterFrontendFiles(baseFiles);

  if (!frontendFiles.some(f => f.path === 'setup.md') && !dotnetFiles.some(f => f.path === 'setup.md')) {
    try {
      const { getRunInstructions } = await import('../../run-instructions.js');
      const ri = getRunInstructions('dotnet-react', { projectName: plan.projectName, projectDescription: plan.overview, dataModel: plan.dataModel });
      dotnetFiles.push({ path: 'setup.md', content: ri.markdown, language: 'markdown' });
    } catch {}
  }

  warnings.push(`.NET adapter: ${dotnetFiles.length} C# files, ${frontendFiles.length} frontend files`);
  return { files: [...frontendFiles, ...dotnetFiles], warnings };
}
