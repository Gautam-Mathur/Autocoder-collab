// structural-fixer.ts — Guardrailed structural cleanup for generated code.
//
// Task #24 — File Explosion Prevention.
//
// Historically this module would invent a brand-new module + stub exports
// for every unresolved import it saw, which produced a hallucination chain
// (bad import → fake module → fake module breaks something → next pass
// invents another fake module → 40+ files for a "calculator" prompt).
//
// New behaviour:
//   - Invention is gated on a plan + budget. A file is only created when:
//       (a) the missing import name matches a planned component / hook /
//           page / api-client / store, AND
//       (b) the project is still under the file / component / route budget.
//   - When invention is rejected, the import is rewritten to a TODO comment
//     and a structured `UnresolvedImport` diagnostic is appended for the
//     auto-fix loop to handle (typically by deleting the orphaned import).
//   - One consolidated summary describes the backfilled and rejected
//     counts; per-file logs are gone.
//
// Default (no plan / no budget — e.g. preview-panel calling without context):
// "allow planned backfill, reject unplanned invention". With no plan,
// nothing matches → all unresolved imports become diagnostics. Never
// silent unbounded invention.

interface ProjectFile {
  id: number;
  path: string;
  content: string;
}

interface StructuralFix {
  fileId: number;
  filePath: string;
  newContent: string;
  description: string;
  type: "broken-import" | "missing-export" | "empty-file" | "circular-dep" | "demoted-import";
}

export interface UnresolvedImport {
  /** File where the unresolved import lives. */
  file: string;
  /** 1-based line number of the import statement. */
  line: number;
  /** Imported name (default-import name or first named import). */
  name: string;
  /** Original import path string. */
  importPath: string;
  /** Why we refused to invent a backfill. */
  reason: 'unplanned' | 'budget-exhausted' | 'no-plan';
}

export interface PlanLookup {
  componentNames?: string[];
  hookNames?: string[];
  pageNames?: string[];
  apiClientNames?: string[];
  storeNames?: string[];
}

export interface InventionBudget {
  /** Total file cap for the project (Number.POSITIVE_INFINITY = unlimited). */
  maxFiles?: number;
  /** Cap on component files. */
  maxComponents?: number;
  /** Cap on route/page files. */
  maxRoutes?: number;
  /** Current total file count (used as the starting point for invention). */
  currentFileCount?: number;
  /** Current component count. */
  currentComponentCount?: number;
  /** Current route count. */
  currentRouteCount?: number;
}

export interface StructuralFixerOptions {
  plan?: PlanLookup;
  budget?: InventionBudget;
}

interface StructuralAnalysis {
  fixes: StructuralFix[];
  issueCount: number;
  summary: string;
  unresolvedImports: UnresolvedImport[];
  backfilled: string[];
  rejected: string[];
}

function extractImports(content: string): string[] {
  const imports: string[] = [];
  const importRegex = /(?:import\s+(?:[\s\S]*?)\s+from\s+["']([^"']+)["']|import\s+["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\))/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const path = match[1] || match[2] || match[3];
    if (path) imports.push(path);
  }
  return imports;
}

function extractNamedImportsFromContent(content: string): { path: string; names: string[]; line: number; raw: string }[] {
  const result: { path: string; names: string[]; line: number; raw: string }[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/);
    if (match) {
      const names = match[1].split(",").map((n) => n.trim().split(" as ")[0].trim()).filter(Boolean);
      result.push({ path: match[2], names, line: i, raw: line });
    }
  }
  return result;
}

function extractExports(content: string): string[] {
  const exports: string[] = [];
  const defaultMatch = content.match(/export\s+default\s+(?:function|class|const|let|var)\s+(\w+)/);
  if (defaultMatch) exports.push("default", defaultMatch[1]);
  const defaultExpr = content.match(/export\s+default\s+/);
  if (defaultExpr && !defaultMatch) exports.push("default");
  const namedExports = Array.from(content.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g));
  for (const m of namedExports) exports.push(m[1]);
  const reExports = Array.from(content.matchAll(/export\s*\{([^}]+)\}/g));
  for (const m of reExports) {
    const names = m[1].split(",").map((n: string) => n.trim().split(/\s+as\s+/).pop()?.trim()).filter(Boolean);
    exports.push(...(names as string[]));
  }
  return Array.from(new Set(exports));
}

function isLocalImport(imp: string): boolean {
  return imp.startsWith("./") || imp.startsWith("../") || imp.startsWith("@/") || imp.startsWith("@shared/");
}

function findMatchingFile(basePath: string, allPaths: string[]): string | null {
  if (allPaths.includes(basePath)) return basePath;
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".json", ".css"];
  for (const ext of extensions) {
    if (allPaths.includes(basePath + ext)) return basePath + ext;
  }
  for (const ext of extensions) {
    if (allPaths.includes(basePath + "/index" + ext)) return basePath + "/index" + ext;
  }
  return null;
}

function resolveImportPath(importPath: string, sourceFile: string, allPaths: string[]): string | null {
  if (importPath.startsWith("@/")) {
    return findMatchingFile("src/" + importPath.slice(2), allPaths);
  }
  if (importPath.startsWith("@shared/")) {
    return findMatchingFile("shared/" + importPath.slice(8), allPaths);
  }
  if (importPath.startsWith("@assets/")) return null;
  if (importPath.startsWith("./") || importPath.startsWith("../")) {
    const sourceDir = sourceFile.split("/").slice(0, -1).join("/");
    const parts = importPath.split("/");
    const resolvedParts = sourceDir ? sourceDir.split("/") : [];
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") { resolvedParts.pop(); continue; }
      resolvedParts.push(part);
    }
    return findMatchingFile(resolvedParts.join("/"), allPaths);
  }
  return null;
}

function inferFileContent(_importPath: string, importedNames: string[]): string {
  const isComponent = importedNames.some(n => /^[A-Z]/.test(n));
  const isType = importedNames.some(n => /^(I[A-Z]|T[A-Z]|.*Type$|.*Props$|.*Schema$)/.test(n));

  const parts: string[] = [];

  for (const name of importedNames) {
    if (/^[A-Z]/.test(name) && !isType) {
      parts.push(`export function ${name}({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {\n  return <div {...props}>{children}</div>;\n}`);
    } else if (name.startsWith("use")) {
      parts.push(`export function ${name}() {\n  return {};\n}`);
    } else if (/Props$|Schema$/.test(name)) {
      parts.push(`export type ${name} = Record<string, any>;`);
    } else if (/^(I[A-Z]|T[A-Z])/.test(name)) {
      parts.push(`export interface ${name} {}`);
    } else {
      parts.push(`export const ${name} = {} as any;`);
    }
  }

  if (isComponent) {
    return `import type { ReactNode } from "react";\n\n${parts.join("\n\n")}\n`;
  }
  return parts.join("\n\n") + "\n";
}

// ────────────────────────────────────────────────────────────────────────────
// Plan / budget gating helpers (Task #24).
// ────────────────────────────────────────────────────────────────────────────

export type PlanCategory = 'component' | 'hook' | 'page' | 'api' | 'store' | null;

/**
 * Classify an unresolved import name against the project plan. Returns the
 * matching plan category, or `null` when the name doesn't appear anywhere
 * in the plan. Pure function — exported for unit tests.
 */
/**
 * Entry-point file names that are ALWAYS allowed to be invented even when
 * absent from the plan. Any react-vite app needs these to boot — refusing
 * to invent them on a "no-plan" technicality leaves the app un-runnable
 * (the exact bug seen on 2026-05-10 portfolio generation).
 *
 * Matched against the leading import name (case-sensitive). Keep the list
 * tight — these are framework conventions, not user code.
 */
export const ENTRY_POINT_ALLOWLIST = new Set<string>([
  'main', 'App', 'index', 'Root', 'Layout', 'Router', 'AppRouter',
]);

/** Case-insensitive entry-point check so `App`, `app`, `APP` all match. */
function isEntryPointName(name: string): boolean {
  if (!name) return false;
  const lower = name.trim().toLowerCase();
  for (const allowed of ENTRY_POINT_ALLOWLIST) {
    if (allowed.toLowerCase() === lower) return true;
  }
  return false;
}

export function isNameInPlan(plan: PlanLookup | undefined, name: string): { kind: PlanCategory } {
  if (!plan || !name) {
    // Even with no plan, framework entry points should still be invented.
    if (isEntryPointName(name)) return { kind: 'component' };
    return { kind: null };
  }
  const norm = name.trim();
  if (!norm) return { kind: null };
  const inList = (list?: string[]) =>
    Array.isArray(list) && list.some(n => typeof n === 'string' && n.trim() === norm);
  if (inList(plan.componentNames)) return { kind: 'component' };
  if (inList(plan.hookNames))      return { kind: 'hook' };
  if (inList(plan.pageNames))      return { kind: 'page' };
  if (inList(plan.apiClientNames)) return { kind: 'api' };
  if (inList(plan.storeNames))     return { kind: 'store' };
  // Framework entry points pass even when not in the plan.
  if (isEntryPointName(norm)) return { kind: 'component' };
  return { kind: null };
}

interface InventionGateState {
  filesCreated: number;
  componentsCreated: number;
  routesCreated: number;
}

/**
 * Decide whether inventing a stub file for `name` (classified as `kind`)
 * is allowed under the supplied budget. Returns `null` to allow, or a
 * reason string to deny.
 */
export function checkInventionBudget(
  budget: InventionBudget | undefined,
  state: InventionGateState,
  kind: PlanCategory,
): 'budget-exhausted' | null {
  if (!budget) return null;
  const cur = (budget.currentFileCount ?? 0) + state.filesCreated;
  if (Number.isFinite(budget.maxFiles ?? Infinity) && cur >= (budget.maxFiles as number)) {
    return 'budget-exhausted';
  }
  if (kind === 'component') {
    const c = (budget.currentComponentCount ?? 0) + state.componentsCreated;
    if (Number.isFinite(budget.maxComponents ?? Infinity) && c >= (budget.maxComponents as number)) {
      return 'budget-exhausted';
    }
  }
  if (kind === 'page') {
    const r = (budget.currentRouteCount ?? 0) + state.routesCreated;
    if (Number.isFinite(budget.maxRoutes ?? Infinity) && r >= (budget.maxRoutes as number)) {
      return 'budget-exhausted';
    }
  }
  return null;
}

function rewriteImportLineToTodo(
  content: string,
  importLine: number,
  name: string,
  reason: UnresolvedImport['reason'],
): string {
  const lines = content.split("\n");
  if (importLine < 0 || importLine >= lines.length) return content;
  const original = lines[importLine];
  const reasonText =
    reason === 'no-plan'           ? 'no project plan available' :
    reason === 'unplanned'         ? 'not in plan' :
    /* budget-exhausted */           'file budget exhausted';
  // Comment out the original import so the file still parses; the
  // diagnostic carries the structured detail for the cascade to act on.
  lines[importLine] = `// TODO: unresolved import '${name}' — ${reasonText}\n// ${original.trim()}`;
  return lines.join("\n");
}

function guessLanguage(_path: string): string {
  return "";
}

function categorizeNameKind(name: string): PlanCategory {
  if (name.startsWith('use')) return 'hook';
  if (/^[A-Z]/.test(name)) return 'component';
  return null;
}

export function analyzeAndAutoFix(
  files: ProjectFile[],
  options: StructuralFixerOptions = {},
): StructuralAnalysis {
  const allPaths = files.map((f) => f.path);
  const fixes: StructuralFix[] = [];
  const createdPaths = new Set<string>();
  const pendingContent = new Map<string, { content: string; fileId: number }>();
  const unresolvedImports: UnresolvedImport[] = [];
  const backfilled: string[] = [];
  const rejected: string[] = [];
  // Track invention so the budget checker sees cumulative growth across imports.
  const gate: InventionGateState = { filesCreated: 0, componentsCreated: 0, routesCreated: 0 };
  // Track per-file rewrites so multiple unresolved imports in the same file
  // accumulate (rather than each rewrite overwriting the previous one).
  const todoRewrites = new Map<string, { fileId: number; content: string }>();
  const noPlan = !options.plan;

  for (const file of files) {
    pendingContent.set(file.path, { content: file.content, fileId: file.id });
  }

  const recordRejection = (
    sourceFile: ProjectFile,
    importLine: number,
    name: string,
    importPath: string,
    reason: UnresolvedImport['reason'],
  ) => {
    unresolvedImports.push({ file: sourceFile.path, line: importLine + 1, name, importPath, reason });
    rejected.push(name);
    const baseEntry = todoRewrites.get(sourceFile.path);
    const baseContent = baseEntry?.content ?? sourceFile.content;
    const rewritten = rewriteImportLineToTodo(baseContent, importLine, name, reason);
    if (rewritten !== baseContent) {
      todoRewrites.set(sourceFile.path, { fileId: sourceFile.id, content: rewritten });
    }
  };

  for (const file of files) {
    if (!file.content) continue;

    const namedImports = extractNamedImportsFromContent(file.content);
    for (const ni of namedImports) {
      if (!isLocalImport(ni.path)) continue;
      const currentPaths = [...allPaths, ...Array.from(createdPaths)];
      const resolved = resolveImportPath(ni.path, file.path, currentPaths);
      if (!resolved) {
        const possiblePath = resolveToCreatablePath(ni.path, file.path);
        if (possiblePath && !createdPaths.has(possiblePath)) {
          // ── Plan + budget gate ─────────────────────────────────────
          // The first imported name is what we classify on. Multi-import
          // statements are uncommon in practice; we accept the gate's
          // decision for the leading name.
          const primaryName = ni.names[0] ?? '';
          const planMatch = isNameInPlan(options.plan, primaryName);
          const isPlanned = planMatch.kind !== null;
          const kindForBudget: PlanCategory = isPlanned ? planMatch.kind : categorizeNameKind(primaryName);

          if (!isPlanned) {
            recordRejection(file, ni.line, primaryName, ni.path, noPlan ? 'no-plan' : 'unplanned');
            continue;
          }

          const denyReason = checkInventionBudget(options.budget, gate, kindForBudget);
          if (denyReason) {
            recordRejection(file, ni.line, primaryName, ni.path, denyReason);
            continue;
          }

          // Allowed: invent the file as before.
          createdPaths.add(possiblePath);
          gate.filesCreated++;
          if (kindForBudget === 'component') gate.componentsCreated++;
          if (kindForBudget === 'page') gate.routesCreated++;
          backfilled.push(possiblePath);
          const allNeededNames = collectAllImportedNames(files, ni.path, possiblePath);
          const uniqueNames = Array.from(new Set([...ni.names, ...allNeededNames]));
          const stubContent = inferFileContent(ni.path, uniqueNames);
          pendingContent.set(possiblePath, { content: stubContent, fileId: -1 });
          fixes.push({
            fileId: -1,
            filePath: possiblePath,
            newContent: stubContent,
            description: `Created planned file '${possiblePath}' with exports: ${uniqueNames.join(", ")}`,
            type: "broken-import",
          });
        } else if (possiblePath && createdPaths.has(possiblePath)) {
          // The file was already invented in this same pass for a different
          // import — append the new exports if any are missing.
          const existing = pendingContent.get(possiblePath);
          if (existing) {
            const existingExports = extractExports(existing.content);
            const newNames = ni.names.filter((n) => !existingExports.includes(n));
            if (newNames.length > 0) {
              let updatedContent = existing.content;
              for (const name of newNames) updatedContent += generateExportStub(name);
              pendingContent.set(possiblePath, { ...existing, content: updatedContent });
              const fix = fixes.find((f) => f.filePath === possiblePath);
              if (fix) {
                fix.newContent = updatedContent;
                fix.description = `Created planned file '${possiblePath}' with exports: ${[...existingExports, ...newNames].join(", ")}`;
              }
            }
          }
        }
        continue;
      }

      // Resolved import — but the target file may be missing the named export.
      // Adding a missing export to an EXISTING planned file is not invention,
      // so we leave this path enabled (it doesn't grow the file count).
      const pending = pendingContent.get(resolved);
      const targetContent = pending?.content || "";
      if (!targetContent) continue;
      const targetExports = extractExports(targetContent);
      const missingNames = ni.names.filter((n) => !targetExports.includes(n));

      if (missingNames.length > 0) {
        let updatedContent = targetContent;
        for (const name of missingNames) updatedContent += generateExportStub(name);
        const targetFileId = pending?.fileId ?? -1;
        pendingContent.set(resolved, { content: updatedContent, fileId: targetFileId });

        const existingFix = fixes.find((f) => f.filePath === resolved && f.type === "missing-export");
        if (existingFix) {
          existingFix.newContent = updatedContent;
          existingFix.description = `Added missing exports to '${getShortName(resolved)}': ${[...new Set([...(existingFix.description.match(/: (.+)$/)?.[1]?.split(", ") || []), ...missingNames])].join(", ")}`;
        } else {
          fixes.push({
            fileId: targetFileId,
            filePath: resolved,
            newContent: updatedContent,
            description: `Added missing exports to '${getShortName(resolved)}': ${missingNames.join(", ")}`,
            type: "missing-export",
          });
        }
      }
    }

    // Default-import handling — same gating story as named imports.
    const imports = extractImports(file.content);
    for (const imp of imports) {
      if (!isLocalImport(imp)) continue;
      const currentPaths = [...allPaths, ...Array.from(createdPaths)];
      const resolved = resolveImportPath(imp, file.path, currentPaths);
      if (!resolved) {
        const inNamed = namedImports.some((ni) => ni.path === imp);
        if (inNamed) continue;

        const defaultImportMatch = file.content.match(new RegExp(`import\\s+(\\w+)\\s+from\\s+["']${escapeRegex(imp)}["']`));
        if (defaultImportMatch) {
          const possiblePath = resolveToCreatablePath(imp, file.path);
          const name = defaultImportMatch[1];
          // Locate the line of this default import for the diagnostic / TODO.
          const lines = file.content.split("\n");
          const defaultRe = new RegExp(`import\\s+${escapeRegex(name)}\\s+from\\s+["']${escapeRegex(imp)}["']`);
          let defaultLine = lines.findIndex(l => defaultRe.test(l));
          if (defaultLine < 0) defaultLine = 0;

          if (possiblePath && !createdPaths.has(possiblePath)) {
            const planMatch = isNameInPlan(options.plan, name);
            const isPlanned = planMatch.kind !== null;
            const kindForBudget: PlanCategory = isPlanned ? planMatch.kind : categorizeNameKind(name);

            if (!isPlanned) {
              recordRejection(file, defaultLine, name, imp, noPlan ? 'no-plan' : 'unplanned');
              continue;
            }
            const denyReason = checkInventionBudget(options.budget, gate, kindForBudget);
            if (denyReason) {
              recordRejection(file, defaultLine, name, imp, denyReason);
              continue;
            }

            createdPaths.add(possiblePath);
            gate.filesCreated++;
            if (kindForBudget === 'component') gate.componentsCreated++;
            if (kindForBudget === 'page') gate.routesCreated++;
            backfilled.push(possiblePath);
            const isComponent = /^[A-Z]/.test(name);
            const content = isComponent
              ? `export default function ${name}({ children, ...props }: any) {\n  return <div {...props}>{children}</div>;\n}\n`
              : `const ${name} = {} as any;\nexport default ${name};\n`;
            pendingContent.set(possiblePath, { content, fileId: -1 });
            fixes.push({
              fileId: -1,
              filePath: possiblePath,
              newContent: content,
              description: `Created planned file '${possiblePath}' with default export '${name}'`,
              type: "broken-import",
            });
          }
        }
      }
    }
  }

  // Empty-file pass — never grows the file count, only fills existing files.
  for (const file of files) {
    if (file.content !== undefined && file.content !== null && file.content.trim().length < 5) {
      const cat = categorizeFile(file.path);
      if (cat !== "config" && cat !== "style") {
        const ext = file.path.split(".").pop() || "";
        if (["ts", "tsx", "js", "jsx"].includes(ext)) {
          const name = getShortName(file.path).replace(/\.[^.]+$/, "");
          const isComponent = /^[A-Z]/.test(name);
          const content = isComponent
            ? `export default function ${name}() {\n  return <div>${name}</div>;\n}\n`
            : `export default {};\n`;
          fixes.push({
            fileId: file.id,
            filePath: file.path,
            newContent: content,
            description: `Filled empty file '${getShortName(file.path)}' with stub content`,
            type: "empty-file",
          });
        }
      }
    }
  }

  // Emit one demoted-import patch per source file containing rejections.
  for (const [path, entry] of todoRewrites.entries()) {
    fixes.push({
      fileId: entry.fileId,
      filePath: path,
      newContent: entry.content,
      description: `Demoted ${rejected.length === 1 ? '1 unplanned import' : 'unplanned imports'} in '${getShortName(path)}' to TODO`,
      type: "demoted-import",
    });
  }

  // Single consolidated summary (Task #24).
  const summary = (() => {
    if (fixes.length === 0 && unresolvedImports.length === 0) return "No structural issues found";
    const parts: string[] = [];
    if (backfilled.length > 0) {
      const names = backfilled.slice(0, 6).join(", ");
      const more = backfilled.length > 6 ? `, +${backfilled.length - 6} more` : "";
      parts.push(`Backfilled ${backfilled.length} planned file${backfilled.length === 1 ? '' : 's'} (${names}${more})`);
    }
    if (rejected.length > 0) {
      const names = rejected.slice(0, 6).join(", ");
      const more = rejected.length > 6 ? `, +${rejected.length - 6} more` : "";
      parts.push(`rejected ${rejected.length} unplanned invention attempt${rejected.length === 1 ? '' : 's'} (${names}${more})`);
    }
    const otherCount = fixes.filter(f => f.type === 'missing-export' || f.type === 'empty-file').length;
    if (otherCount > 0) parts.push(`${otherCount} other structural fix${otherCount === 1 ? '' : 'es'}`);
    return parts.join('; ');
  })();

  return { fixes, issueCount: fixes.length, summary, unresolvedImports, backfilled, rejected };
}

function generateExportStub(name: string): string {
  if (/^[A-Z]/.test(name) && !/Props$|Schema$|Type$/.test(name)) {
    return `\nexport function ${name}({ children, ...props }: any) {\n  return <div {...props}>{children}</div>;\n}\n`;
  } else if (name.startsWith("use")) {
    return `\nexport function ${name}() {\n  return {};\n}\n`;
  } else if (/Props$|Schema$|Type$/.test(name)) {
    return `\nexport type ${name} = Record<string, any>;\n`;
  } else if (/^(I[A-Z]|T[A-Z])/.test(name)) {
    return `\nexport interface ${name} {}\n`;
  } else {
    return `\nexport const ${name} = {} as any;\n`;
  }
}

function collectAllImportedNames(files: ProjectFile[], _importPath: string, resolvedTarget: string): string[] {
  const allNames: string[] = [];
  for (const file of files) {
    if (!file.content) continue;
    const namedImports = extractNamedImportsFromContent(file.content);
    for (const ni of namedImports) {
      if (!isLocalImport(ni.path)) continue;
      const possiblePath = resolveToCreatablePath(ni.path, file.path);
      if (possiblePath === resolvedTarget) {
        allNames.push(...ni.names);
      }
    }
  }
  return allNames;
}

function resolveToCreatablePath(importPath: string, sourceFile: string): string | null {
  let basePath: string;
  if (importPath.startsWith("@/")) {
    basePath = "src/" + importPath.slice(2);
  } else if (importPath.startsWith("@shared/")) {
    basePath = "shared/" + importPath.slice(8);
  } else if (importPath.startsWith("./") || importPath.startsWith("../")) {
    const sourceDir = sourceFile.split("/").slice(0, -1).join("/");
    const parts = importPath.split("/");
    const resolvedParts = sourceDir ? sourceDir.split("/") : [];
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") { resolvedParts.pop(); continue; }
      resolvedParts.push(part);
    }
    basePath = resolvedParts.join("/");
  } else {
    return null;
  }

  if (/\.[a-z]+$/i.test(basePath)) return basePath;

  const sourceExt = sourceFile.match(/\.(tsx?|jsx?|css|json)$/)?.[0] || ".ts";
  return basePath + sourceExt;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getShortName(path: string): string {
  return path.split("/").pop() || path;
}

type FileCategory = "config" | "schema" | "server" | "page" | "component" | "hook" | "style" | "other";

function categorizeFile(path: string): FileCategory {
  const lower = path.toLowerCase();
  if (lower.endsWith(".css") || lower.endsWith(".scss")) return "style";
  if (lower.includes("schema") || lower.includes("db.ts") || lower.includes("drizzle")) return "schema";
  if (lower.includes("server/") || lower.includes("routes") || lower.includes("auth.ts")) return "server";
  if (lower.includes("pages/") || lower.includes("page.tsx") || lower.includes("page.ts")) return "page";
  if (lower.includes("components/") || lower.includes("component")) return "component";
  if (lower.includes("hooks/") || lower.includes("lib/") || lower.includes("utils")) return "hook";
  if (lower.includes("package.json") || lower.includes("tsconfig") || lower.includes("vite.config") || lower.includes("tailwind.config") || lower.includes("postcss") || lower.includes(".config")) return "config";
  return "other";
}
