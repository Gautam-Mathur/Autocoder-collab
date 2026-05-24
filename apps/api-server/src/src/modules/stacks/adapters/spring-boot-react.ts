/**
 * Stack Adapter: Spring Boot + React Vite
 *
 * Generates:
 *   - pom.xml (Spring Boot 3 + JPA + PostgreSQL + Validation)
 *   - Entity, Repository, Service, Controller for each entity
 *   - application.properties
 *   - React Vite frontend (keeps base files)
 */

import type { ProjectPlan } from '../../plan-generator.js';
import type { GeneratedFile } from '../../pipeline-orchestrator.js';
import { filterFrontendFiles } from './frontend-filter.js';

export interface AdapterResult {
  files: GeneratedFile[];
  warnings: string[];
}

function entityToJava(entity: any, basePackage: string): GeneratedFile[] {
  const name = entity.name;
  const fields = (entity.fields ?? []) as any[];
  const pkg = `${basePackage}.entity`;

  const fieldDecls = fields.map(f => {
    const javaType = f.type === 'number' ? 'Integer'
      : f.type === 'boolean' ? 'Boolean'
      : f.type === 'date' ? 'LocalDateTime'
      : 'String';
    const annotations = f.name === 'email' ? '    @Column(unique = true)\n' : '';
    const nullable = f.required ? '    @Column(nullable = false)\n' : '';
    return `${annotations}${nullable}    private ${javaType} ${f.name};`;
  }).join('\n\n');

  const entity_file: GeneratedFile = {
    path: `src/main/java/${basePackage.replace(/\./g, '/')}/${name}.java`,
    language: 'java',
    content: `package ${basePackage};

import jakarta.persistence.*;
import lombok.*;
import java.time.LocalDateTime;

@Entity
@Table(name = "${name.toLowerCase()}s")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ${name} {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

${fieldDecls}

    @Column(updatable = false)
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    @PrePersist
    protected void onCreate() { createdAt = LocalDateTime.now(); updatedAt = LocalDateTime.now(); }

    @PreUpdate
    protected void onUpdate() { updatedAt = LocalDateTime.now(); }
}
`,
  };

  const repo: GeneratedFile = {
    path: `src/main/java/${basePackage.replace(/\./g, '/')}/repository/${name}Repository.java`,
    language: 'java',
    content: `package ${basePackage}.repository;

import ${basePackage}.${name};
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;
import java.util.List;

@Repository
public interface ${name}Repository extends JpaRepository<${name}, Long> {
    List<${name}> findAllByOrderByCreatedAtDesc();
}
`,
  };

  const service: GeneratedFile = {
    path: `src/main/java/${basePackage.replace(/\./g, '/')}/service/${name}Service.java`,
    language: 'java',
    content: `package ${basePackage}.service;

import ${basePackage}.${name};
import ${basePackage}.repository.${name}Repository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import java.util.List;

@Service
@RequiredArgsConstructor
public class ${name}Service {
    private final ${name}Repository repository;

    public List<${name}> findAll() { return repository.findAllByOrderByCreatedAtDesc(); }
    public ${name} findById(Long id) { return repository.findById(id).orElseThrow(() -> new RuntimeException("${name} not found: " + id)); }
    public ${name} create(${name} entity) { return repository.save(entity); }
    public ${name} update(Long id, ${name} data) { data.setId(id); return repository.save(data); }
    public void delete(Long id) { repository.deleteById(id); }
}
`,
  };

  const controller: GeneratedFile = {
    path: `src/main/java/${basePackage.replace(/\./g, '/')}/controller/${name}Controller.java`,
    language: 'java',
    content: `package ${basePackage}.controller;

import ${basePackage}.${name};
import ${basePackage}.service.${name}Service;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api/${name.toLowerCase()}s")
@RequiredArgsConstructor
@CrossOrigin(origins = {"http://localhost:5173", "http://localhost:3000"})
public class ${name}Controller {
    private final ${name}Service service;

    @GetMapping
    public List<${name}> list() { return service.findAll(); }

    @GetMapping("/{id}")
    public ResponseEntity<${name}> get(@PathVariable Long id) { return ResponseEntity.ok(service.findById(id)); }

    @PostMapping
    public ResponseEntity<${name}> create(@RequestBody ${name} body) { return ResponseEntity.status(201).body(service.create(body)); }

    @PutMapping("/{id}")
    public ResponseEntity<${name}> update(@PathVariable Long id, @RequestBody ${name} body) { return ResponseEntity.ok(service.update(id, body)); }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable Long id) { service.delete(id); return ResponseEntity.noContent().build(); }
}
`,
  };

  return [entity_file, repo, service, controller];
}

export async function adaptSpringBootReact(
  plan: ProjectPlan,
  baseFiles: GeneratedFile[]
): Promise<AdapterResult> {
  const warnings: string[] = [];
  const springFiles: GeneratedFile[] = [];
  const groupId = 'com.app';
  const artifactId = (plan.projectName ?? 'app').toLowerCase().replace(/[^a-z0-9]/g, '');
  const basePackage = `${groupId}.${artifactId}`;

  // ── pom.xml
  springFiles.push({
    path: 'pom.xml',
    language: 'xml',
    content: `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.2.0</version>
    </parent>
    <groupId>${groupId}</groupId>
    <artifactId>${artifactId}</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <properties><java.version>21</java.version></properties>
    <dependencies>
        <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
        <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency>
        <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-validation</artifactId></dependency>
        <dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId><scope>runtime</scope></dependency>
        <dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId><optional>true</optional></dependency>
        <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId><scope>test</scope></dependency>
    </dependencies>
    <build>
        <plugins>
            <plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin>
        </plugins>
    </build>
</project>
`,
  });

  // ── application.properties
  springFiles.push({
    path: 'src/main/resources/application.properties',
    language: 'properties',
    content: `spring.datasource.url=\${DATABASE_URL:jdbc:postgresql://localhost:5432/${artifactId}}
spring.datasource.username=\${DB_USER:postgres}
spring.datasource.password=\${DB_PASSWORD:}
spring.jpa.hibernate.ddl-auto=update
spring.jpa.show-sql=true
spring.jpa.properties.hibernate.format_sql=true
server.port=\${PORT:8080}
`,
  });

  // ── Main application class (always injected — frontend filter drops any
  // LLM-produced backend Java, so this guarantees a runnable entry point)
  const appClassName = artifactId.charAt(0).toUpperCase() + artifactId.slice(1) + 'Application';
  const appJavaPath = `src/main/java/${basePackage.replace(/\./g, '/')}/${appClassName}.java`;
  springFiles.push({
    path: appJavaPath,
    language: 'java',
    content: `package ${basePackage};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ${appClassName} {
    public static void main(String[] args) {
        SpringApplication.run(${appClassName}.class, args);
    }
}
`,
  });
  warnings.push(`spring-boot-react adapter: injected baseline ${appClassName}.java entry`);

  // ── Entities
  for (const entity of plan.dataModel ?? []) {
    springFiles.push(...entityToJava(entity, basePackage));
  }

  const frontendFiles = filterFrontendFiles(baseFiles);

  if (!frontendFiles.some(f => f.path === 'setup.md') && !springFiles.some(f => f.path === 'setup.md')) {
    try {
      const { getRunInstructions } = await import('../../run-instructions.js');
      const ri = getRunInstructions('spring-boot-react', { projectName: plan.projectName, projectDescription: plan.overview, dataModel: plan.dataModel });
      springFiles.push({ path: 'setup.md', content: ri.markdown, language: 'markdown' });
    } catch {}
  }

  warnings.push(`Spring Boot adapter: ${springFiles.length} Java files, ${frontendFiles.length} frontend files`);

  return { files: [...frontendFiles, ...springFiles], warnings };
}
